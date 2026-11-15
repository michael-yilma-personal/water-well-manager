#!/usr/bin/env bash
#
# Fail if a secret-shaped string is in a tracked (or about-to-be-tracked) file.
#
# Exit 0 = clean, 1 = something secret-shaped was found, 2 = the scan itself
# could not run (not a repository, a file could not be read). A scan that
# fails is never reported as clean.
#
# Output is "file:line" only ("file (staged):line" for a hit in the index,
# "file (keystore file)" for a file flagged by its name). The matched text is
# never printed, because this runs in CI and the logs of a public repository
# are public.
#
# What is scanned: every file git lists (tracked, plus untracked ones that are
# not ignored) as it is in the working tree, and, for every tracked file whose
# working copy differs from the index or is gone, the staged content too -
# what is staged is what the next commit takes. Lockfiles are skipped.
#
# What it looks for (letter case is ignored unless stated):
#   - Supabase secret keys (sb_secret_...) and management tokens (sbp_...)
#   - a PEM private key header
#   - a service-role key assigned in any common form (env, JSON, YAML, source)
#   - a bare JWT: three base64url segments, starting eyJ, 100 characters or
#     more (case-sensitive)
#   - a URL with an inline password, scheme://user:password@host, for any
#     scheme (Postgres with or without a driver suffix or a user, https, ...)
#   - GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_)
#   - Stripe live keys (sk_live_, rk_live_) and webhook secrets (whsec_)
#   - Gradle storePassword / keyPassword and Capacitor keystorePassword /
#     keystoreAliasPassword given a literal value, in name=value,
#     name = value, name: value, name value, name "value", name("value") and
#     JSON forms
#   - an upper-case NAME_PASSWORD= or PGPASSWORD= assignment with a literal
#     value (case-sensitive; the "=" form only)
#   - files named *.jks, *.keystore or *.p12, by name alone
# The publishable key (sb_publishable_...) is public by design and not matched.
#
# Limits: it matches shapes, not meaning. A secret in another shape, split
# across lines, encoded, or in a binary or git-ignored file is not seen, and
# git history is not scanned. A password that is a variable reference or a
# placeholder (starting with $, <, [ or {) is not reported; nor is a URL
# password spelled only with the letters of "password" (password, pass,
# passwd, pw - what documentation writes); neither is an
# unquoted signing password that contains a dot, a bracket or a parenthesis
# (it cannot be told from code that reads the value from somewhere else), nor
# a password given as "NAME_PASSWORD: value" (YAML) or in lower case.
#
# CHECK_SECRETS_ROOT points the script at another repository (used by the tests).

set -uo pipefail
export LC_ALL=C

ROOT="${CHECK_SECRETS_ROOT:-$(dirname "$0")/..}"
cd "$ROOT" 2>/dev/null || { echo "check-secrets: cannot enter $ROOT; the scan did not run." >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "check-secrets: cannot create a temporary directory." >&2; exit 2; }
trap 'rm -rf "$WORK"' EXIT

# Each pattern is written so that it does not match its own text in this file.
Q="[\"']"                                   # a quote of either kind
SIGN='(store|key|keystore|keystorealias)password'
NOTWORD='(^|[^A-Za-z0-9_])'
# Matched without regard to letter case.
PATTERNS=(
  'sb_secret_[A-Za-z0-9_-]{8,}'
  'sbp_[A-Za-z0-9]{20,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  "service[_-]?role[A-Za-z0-9_]*$Q?[[:space:]]*[:=][[:space:]]*$Q?ey[A-Za-z0-9_.-]{20,}"
  '[a-z][a-z0-9+.-]*://[^:/@[:space:]]*:[adoprsw]*[^]adoprsw@/[:space:]$<[{][^@/[:space:]]*@'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{22,}'
  '[sr]k_live_[A-Za-z0-9]{10,}'
  'whsec_[A-Za-z0-9]{10,}'
  # Signing passwords. name=value with nothing between:
  "(^|[^A-Za-z0-9_.\"'[])(store|key)Password=[^<\$[:space:]\"']+"
  # name "value", name = "value", name("value"), "name": "value":
  "$NOTWORD$SIGN$Q?[[:space:]]*[(:=]?[[:space:]]*$Q[^]\"'\$<[{][^\"'\$]*$Q"
  # name = value, name: value, prefix.name=value - unquoted, up to the end of the line:
  "$NOTWORD$SIGN[[:space:]]*[=:][[:space:]]*[^]\"'\$<[{(.[:space:]][^]\"'\$<[{(.[:space:]]*[[:space:]]*\$"
  # name value - unquoted: the name starts the line and one word ends it:
  "^[[:space:]]*$SIGN[[:space:]]+[^]\"'\$<[{(.=:[:space:]][^]\"'\$<[{(.[:space:]]*[[:space:]]*\$"
)
# Matched with regard to letter case.
CASE_PATTERNS=(
  # A JWT candidate; its length is checked afterwards (a regular expression
  # cannot bound the total length of three segments).
  'eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+'
  "(^|[^A-Za-z0-9])([A-Z0-9]+_PASSWORD|PGPASSWORD)=$Q?[^]\"'\$<[{[:space:]]"
)

PATTERN_ARGS=()
for p in "${PATTERNS[@]}"; do PATTERN_ARGS+=(-e "$p"); done
CASE_ARGS=()
for p in "${CASE_PATTERNS[@]}"; do CASE_ARGS+=(-e "$p"); done

# Tracked files plus untracked-but-not-ignored ones.
if ! git ls-files -co --exclude-standard -z > "$WORK/listed" 2> "$WORK/git-error"; then
  echo "check-secrets: cannot list the files of $ROOT (is it a git repository?); the scan did not run." >&2
  cat "$WORK/git-error" >&2
  exit 2
fi

: > "$WORK/hits"
: > "$WORK/errors"

skipped() {
  case "$1" in package-lock.json|*/package-lock.json|bun.lock|*/bun.lock) return 0 ;; esac
  return 1
}

# Working-tree files, minus lockfiles (long hashes, no secrets) and files
# deleted from the working tree. Every name is given to grep as ./name, so a
# file called "-q" or "--include=x" is a file and never an option.
: > "$WORK/files"
while IFS= read -r -d '' f; do
  case "$f" in
    *.jks|*.keystore|*.p12|*.JKS|*.KEYSTORE|*.P12) printf '%s (keystore file)\n' "$f" >> "$WORK/hits" ;;
  esac
  skipped "$f" && continue
  [ -f "$f" ] && printf './%s\0' "$f" >> "$WORK/files"
done < "$WORK/listed"

# Tracked files whose staged content is not what is on disk (edited or deleted
# after `git add`).
if ! git diff --name-only -z > "$WORK/unstaged" 2>> "$WORK/errors"; then
  echo "check-secrets: git could not compare the index with the working tree." >> "$WORK/errors"
fi

# Keep "file:line" for the lines that hold a secret-shaped string; the text
# stops here. Input is grep output, "file<TAB>line:text": the tab is the NUL
# grep printed after the file name. A line that matched only the JWT candidate
# counts when the candidate is 100 characters or longer.
#   locations <mode>     mode is "any" (every line counts) or "case"
locations() {
  tr '\0' '\t' | awk -F '\t' -v mode="$1" '{
    file = $1; sub(/^\.\//, "", file)
    rest = substr($0, length($1) + 2)
    n = rest; sub(/:.*/, "", n)
    text = substr(rest, length(n) + 2)
    if (mode == "case" && text !~ /(^|[^A-Za-z0-9])([A-Z0-9]+_PASSWORD|PGPASSWORD)=["\047]?[^]"\047$<[{ \t\r]/) {
      found = 0
      while (match(text, /eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/)) {
        if (RLENGTH >= 100) { found = 1; break }
        text = substr(text, RSTART + RLENGTH)
      }
      if (!found) next
    }
    print file ":" n
  }'
}

if [ -s "$WORK/files" ]; then
  xargs -0 grep -nIiHE --null "${PATTERN_ARGS[@]}" -- < "$WORK/files" 2>> "$WORK/errors" | locations any >> "$WORK/hits"
  xargs -0 grep -nIHE --null "${CASE_ARGS[@]}" -- < "$WORK/files" 2>> "$WORK/errors" | locations case >> "$WORK/hits"
fi

while IFS= read -r -d '' f; do
  skipped "$f" && continue
  label="$f (staged)"
  if ! git cat-file -e ":$f" 2>/dev/null; then
    continue   # not in the index (an intent-to-add entry, or removed since)
  fi
  if ! git show ":$f" > "$WORK/blob" 2>> "$WORK/errors"; then
    echo "check-secrets: cannot read the staged content of $f." >> "$WORK/errors"
    continue
  fi
  grep -nIiE "${PATTERN_ARGS[@]}" < "$WORK/blob" 2>> "$WORK/errors" \
    | awk -v label="$label" '{ printf "%s\t%s\n", label, $0 }' | locations any >> "$WORK/hits"
  grep -nIE "${CASE_ARGS[@]}" < "$WORK/blob" 2>> "$WORK/errors" \
    | awk -v label="$label" '{ printf "%s\t%s\n", label, $0 }' | locations case >> "$WORK/hits"
done < "$WORK/unstaged"

if [ -s "$WORK/errors" ]; then
  echo "check-secrets: the scan failed, so the result is not trusted:" >&2
  cat "$WORK/errors" >&2
  exit 2
fi

if [ -s "$WORK/hits" ]; then
  echo "Possible secrets found (file:line; the matched text is not printed):"
  sort -u "$WORK/hits" | sed 's/^/  /'
  exit 1
fi
echo "No secret-shaped strings in tracked files."
