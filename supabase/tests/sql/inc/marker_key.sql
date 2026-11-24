-- THE MARKER'S KEY (SaaS Phase 2, task P2-1, criterion 8).
--
-- An auth account created for an organization other than the founding one
-- carries, in app_metadata (auth.users.raw_app_meta_data, which only the
-- service role can write), a key naming that organization. The criterion
-- leaves the key's NAME to the Developer. It is defined here and nowhere
-- else in the tests; `saas_org` is the working name. Its value is taken to be
-- the organization's id as text.
\set marker_key saas_org
