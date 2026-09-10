# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- POS Profile's "Tax Inclusive" setting now controls whether an invoice's tax is calculated inclusive or exclusive of item price, replacing the old always-inclusive default. Existing POS Profiles are backfilled to inclusive (matching prior behaviour) during the upgrade.

### Known limitation
- Unchecking "Tax Inclusive" on a POS Profile can block offline payments on sites whose tax template uses a charge type other than "On Net Total" — offline tax computation only supports that charge type, so the cashier will be asked to reconnect before completing the sale in that case.

## [1.0.0] - 2026-02-17

First stable release of POSpire — a modern, full-featured Point of Sale application built on ERPNext.

### Added
- Real-time item search with barcode scanning
- Multiple payment methods (Cash, Card, M-Pesa, custom modes)
- POS Offers and Coupons engine with flexible discount rules
- Customer management with loyalty and referral programs
- Opening/Closing shift management with reconciliation
- Sales order fulfillment from POS
- Delivery charges with address-based calculations
- Draft invoice management for parking transactions
- Returns and exchange processing
- Hardware integration (receipt printers, barcode scanners, cash drawers)
- XML-based receipt print designer
- Multi-terminal support via POS Profile configuration
- POS Profile extended with 50+ configuration options
- GitHub issue templates for bug reports, feature requests, and questions
- GitHub Actions CI workflow (tests against Frappe/ERPNext v15)
- Linter workflow (pre-commit, Semgrep, pip-audit)
- Unit tests (53 tests passing)

[1.0.0]: https://github.com/promantia-ltd/POSpire/releases/tag/v1.0.0
