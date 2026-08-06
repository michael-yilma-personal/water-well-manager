"""Header must not overlap or spill at any window width.

Sweeps 320-1440px in 20px steps rather than checking a few breakpoints: the
collision that prompted this test only appeared between 640px and 900px, which
no fixed set of phone sizes would have caught.

Exits non-zero if any width has overlapping controls or controls past the edge.
"""
from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'

DETECT = r"""
() => {
  const header = document.querySelector('header') || document.body.firstElementChild;
  if (!header) return null;
  const vw = document.documentElement.clientWidth;
  const els = [...header.querySelectorAll('button, a, input, select')].filter(el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const label = el => (el.innerText || el.getAttribute('title') || el.tagName)
      .trim().replace(/\s+/g, ' ').slice(0, 34);

  const overlaps = [];
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 1 && oy > 1) overlaps.push(`${label(a)} x ${label(b)} (${Math.round(ox)}x${Math.round(oy)})`);
    }
  }
  const spill = els.filter(el => {
    const r = el.getBoundingClientRect();
    return r.right > vw + 1 || r.left < -1;
  }).map(label);

  const hr = header.getBoundingClientRect();
  const tooTall = els.filter(el => el.getBoundingClientRect().bottom > hr.bottom + 1).map(label);

  return { overlaps, spill, tooTall, headerH: Math.round(hr.height), vw };
}
"""

def sweep(url, name, sign_in=None):
    print(f'\n===== {name} ({url}) =====')
    bad = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 1440, 'height': 900})
        page = ctx.new_page()
        page.goto(url, wait_until='networkidle')
        page.wait_for_timeout(2000)
        if sign_in and 'input[type="email"]' in page.content():
            page.fill('input[type="email"]', sign_in[0])
            page.fill('input[type="password"]', sign_in[1])
            page.get_by_role('button', name=sign_in[2]).click()
            page.wait_for_timeout(5000)
        elif 'link this device' in page.inner_text('body').lower():
            page.get_by_role('button', name='Work offline for now').click()
            page.wait_for_timeout(2500)

        for w in range(320, 1460, 20):
            page.set_viewport_size({'width': w, 'height': 900})
            page.wait_for_timeout(160)
            r = page.evaluate(DETECT)
            if not r:
                continue
            if r['overlaps'] or r['spill'] or r['tooTall']:
                bad.append((w, r))
        for w, r in bad:
            issues = []
            if r['overlaps']:
                issues.append(f"OVERLAP {r['overlaps'][:2]}")
            if r['spill']:
                issues.append(f"SPILL {r['spill'][:3]}")
            if r['tooTall']:
                issues.append(f"OUTSIDE HEADER {r['tooTall'][:3]}")
            print(f"  {w}px  h={r['headerH']}  " + ' | '.join(issues))
        if not bad:
            print('  no overlap or spill at any width 320-1440')
        # capture the worst offender
        if bad:
            worst = bad[len(bad) // 2][0]
            page.set_viewport_size({'width': worst, 'height': 900})
            page.wait_for_timeout(400)
            page.screenshot(path=f'{OUT}/header-{name}-{worst}.png')
            print(f'  screenshot at {worst}px -> header-{name}-{worst}.png')
        b.close()
    return bad



import sys as _sys
_field = sweep('http://localhost:3000/', 'field')
_dash = sweep('http://localhost:3000/admin.html', 'dashboard',
              ('admin1@example.com', 'TestPass123!', 'Sign in'))
_bad = len(_field) + len(_dash)
print(f"\n{'PASS' if _bad == 0 else 'FAIL'} - {_bad} width(s) with layout collisions")
_sys.exit(0 if _bad == 0 else 1)
