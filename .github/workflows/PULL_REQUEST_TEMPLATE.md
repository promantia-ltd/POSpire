## Description
Brief description of changes made.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (would cause existing functionality to break)
- [ ] Documentation update

## Frappe Framework Standards Checklist
- [ ] Used Frappe methods (frappe.get_doc, frappe.db.get_value) instead of raw SQL
- [ ] Used frappe.throw() with frappe._() for user-facing errors
- [ ] Added permission checks via frappe.has_permission()
- [ ] Used frappe.log_error() instead of prints
- [ ] Followed DocType controller patterns (validate, before_save, etc.)
- [ ] Used frappe.utils functions for common ops
- [ ] Custom fields use custom_ prefix

## Code Quality Checklist
- [ ] Follows Python PEP 8
- [ ] No hardcoded values (moved to config/constants)
- [ ] Added error handling
- [ ] Docstrings for new funcs/classes
- [ ] Self-documenting code with clear names

## Testing
- [ ] Unit tests added/updated
- [ ] Manual testing completed
- [ ] Edge cases considered

## Branch Management
- [ ] Branch naming convention (feature/XXX-description)
- [ ] Targeting correct base branch (main or develop)
- [ ] All CI checks passing

## Deployment & Environment Dependencies
- [ ] Target environment(s) identified: [ ] TEST  [ ] UAT  [ ] PROD
- [ ] Verified schema / custom field / fixture parity across target envs
- [ ] Confirmed dependent app & branch versions match the target env
- [ ] Required patches / migrations listed and ordered
- [ ] Data backfill or reconciliation steps documented (if any)
- [ ] Config / environment variables noted
- [ ] Deploy sequence agreed (which env first, promotion path)
- [ ] Rollback plan documented
- [ ] Downtime / maintenance window required?  [ ] Yes  [ ] No
- [ ] Promotion path and required approver identified
      (UAT -> PROD sign-off handled in the release/deploy step)

## Frappe / ERPNext Version & Environment Parity
(Applies when the PR touches dependencies, migrations, or a version bump; else N/A)
- [ ] Frappe Framework version matches across DEV / UAT / PROD
- [ ] ERPNext version matches across DEV / UAT / PROD
- [ ] All dependent apps on identical branch/commit in each env
- [ ] App pyproject.toml compatibility range satisfied by target Frappe version
- [ ] Branch follows version-X naming for the target core stack
- [ ] Python version matches target Frappe major (e.g. v16 -> 3.14.x)
- [ ] Node version matches target requirement
- [ ] bench migrate verified on a UAT restore of PROD data
- [ ] patches.txt entries idempotent and correctly ordered
- [ ] Fixtures / custom fields / property setters present in target
- [ ] No incompatible app left registered in apps.txt after branch switch
- [ ] Backport needed to lower supported version?  [ ] Yes  [ ] No
- [ ] Pre-deploy snapshot taken and restore path verified

## Documentation
- [ ] Updated relevant docs
- [ ] Inline comments for complex logic
- [ ] Updated CHANGELOG.md if needed
