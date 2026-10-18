# Remote access setup (REST, no shell / MCP)

One-time per site, done by a System Manager:

1. Deploy a POSpire build that includes `pospire/pospire/api/diagnostics.py`
   and run `bench --site <site> migrate` — `after_migrate` creates the
   **POSpire RCA Reader** role.
2. Create a user, e.g. `rca-bot@<company>`:
   - User Type: System User, roles: **POSpire RCA Reader** only.
   - No other roles: the endpoint reads with server-side queries, so the
     user needs no doctype permissions, and the API key can do nothing else
     useful.
3. User → Settings → **API Access → Generate Keys**. Copy key + secret once.
4. Hand the secret to engineers via your password manager. Each engineer
   exports in their own shell (never commit, never paste into chat):
   ```bash
   export POSPIRE_RCA_URL=https://<site>
   export POSPIRE_RCA_API_KEY=<key>
   export POSPIRE_RCA_API_SECRET=<secret>
   ```
5. Smoke test: `python3 collect.py --remote --fleet | head`.

Rotation: regenerate keys on the user (old ones stop working at once).
Revocation: disable the user.

Audit: each call logs `{"event": "get_rca_bundle", "by": …, identifiers}` to
the `pospire.rca` logger (`logs/pospire.rca.log` on the bench), and normal
request logs record the API user.

Raw REST fallback (sites without the endpoint), same token header:
```bash
H="Authorization: token $POSPIRE_RCA_API_KEY:$POSPIRE_RCA_API_SECRET"
curl -sG -H "$H" "$POSPIRE_RCA_URL/api/resource/Error%20Log" \
  --data-urlencode 'filters=[["method","like","POSpire%"]]' \
  --data-urlencode 'fields=["name","creation","method","error"]' \
  --data-urlencode 'order_by=creation desc' --data-urlencode 'limit_page_length=50'
```
That fallback does need doctype read permissions on the API user.
