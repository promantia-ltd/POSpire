# Copyright (c) 2026, POSpire and contributors
# For license information, please see license.txt

"""Header controller for the offline Service Worker.

The actual Service Worker JS lives at `pospire/www/sw.js` — written there
by the Vite build plugin (`frontend/vite-plugin-sw.js`) after substituting
the BUILD_HASH and precache URL list. Frappe's TemplatePage renderer serves
that file at `/sw.js` automatically.

This companion file's only job is to add response headers:

* `Service-Worker-Allowed: /` — explicit even though serving from /sw.js
  already gives root scope by default; harmless and protects against any
  reverse proxy that strips trailing-slash semantics.
* `Cache-Control: no-cache, no-store, must-revalidate` — the SW source
  itself shouldn't be cached by the browser; the SW manages its own
  versioned cache lifecycle.
* `no_cache = 1` (module-level) disables Frappe's Redis cache for the
  rendered page (same convention as frappe/www/website_script.py).
"""

from __future__ import annotations

import frappe

no_cache = 1


def get_context(_context) -> None:
	frappe.local.response_headers["Service-Worker-Allowed"] = "/"
	frappe.local.response_headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
