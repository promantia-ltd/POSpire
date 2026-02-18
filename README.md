# POSpire

A modern, feature-rich Point of Sale (POS) application built on the Frappe Framework and ERPNext. POSpire provides an intuitive Vue.js-based interface with Vuetify 3 components for seamless retail operations.

## Features

### Core POS Functionality
- **Invoice Management** - Create, edit, and manage sales invoices with real-time updates
- **Item Selection** - Grid and list views with barcode scanning support
- **Customer Management** - Quick customer lookup, creation, and editing
- **Multiple Payment Methods** - Cash, card, and mobile payments (M-Pesa integration)
- **Returns & Refunds** - Handle returns with linked invoice tracking

### Advanced Features
- **POS Opening/Closing Shifts** - Track cash movements and shift reconciliation
- **Coupons & Offers** - Apply promotional discounts and coupon codes
- **Batch & Serial Number Support** - Track inventory with batch/serial numbers
- **Draft Invoices** - Save and resume incomplete transactions
- **Sales Orders** - Create and convert sales orders to invoices
- **Delivery Charges** - Configurable delivery charge management
- **Payment Reconciliation** - Match and reconcile outstanding payments

### Hardware Integration
- Receipt printer support via Hardware Manager
- Barcode scanner integration
- Scale barcode reading for weighted items

### User Experience
- Responsive design with teal color scheme
- Real-time stock availability display
- Multi-language support via Frappe translations

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.10+, Frappe Framework |
| Frontend | Vue.js 3, Vuetify 3.6 |
| Database | MariaDB (via Frappe) |
| Build Tools | Yarn, ESLint, Ruff |

## Requirements

- Frappe Bench
- Frappe Framework v15+
- ERPNext v15+
- Python 3.10+
- Node.js 18+

## Installation

```bash
# Navigate to your bench directory
cd $PATH_TO_YOUR_BENCH

# Get the app
bench get-app https://github.com/promantia-ltd/POSpire.git --branch develop

# Install on your site
bench --site your-site.local install-app pospire

# Build assets
bench build --app pospire
```

## Configuration

### POS Profile Setup

POSpire extends the standard ERPNext POS Profile with additional settings:

1. Navigate to **POS Profile** in ERPNext
2. Configure the **POSpire Settings** section:
   - Enable/disable features (returns, partial payments, credit sales)
   - Set discount limits and permissions
   - Configure item display options (card/list view, stock display)
   - Set up payment modes and hardware integration

### Custom Fields

POSpire adds custom fields to the following DocTypes:
- **POS Profile** - Extended settings for POSpire features
- **Sales Invoice** - POS shift linking, offers, notes
- **Sales Invoice Item** - Offer tracking, item notes
- **Customer** - Referral codes, discounts, birthday
- **Company** - Referral program settings

## Project Structure

```
pospire/
├── pospire/
│   ├── api/                    # Whitelisted API methods
│   │   ├── posapp.py           # Core POS API endpoints
│   │   ├── payment_entry.py    # Payment processing
│   │   ├── invoice.py          # Invoice hooks
│   │   └── hardware_manager.py # Printer/hardware APIs
│   ├── pospire/
│   │   └── doctype/            # Custom DocTypes
│   │       ├── pos_opening_shift/
│   │       ├── pos_closing_shift/
│   │       ├── pos_offer/
│   │       ├── pos_coupon/
│   │       └── ...
│   ├── public/
│   │   ├── css/
│   │   │   └── pos-enhancements.css
│   │   └── js/posapp/
│   │       └── components/
│   │           ├── pos/        # POS components
│   │           │   ├── Invoice.vue
│   │           │   ├── ItemsSelector.vue
│   │           │   ├── Payments.vue
│   │           │   └── ...
│   │           ├── payments/   # Payment reconciliation
│   │           │   └── Pay.vue
│   │           └── Navbar.vue
│   └── hooks.py                # Frappe hooks configuration
├── package.json
├── pyproject.toml
└── README.md
```

## Development

### Prerequisites

```bash
# Install pre-commit hooks
cd apps/pospire
pre-commit install
```

### Code Quality Tools

The project uses the following tools for code quality:

| Tool | Purpose |
|------|---------|
| **Ruff** | Python linting and formatting |
| **ESLint** | JavaScript/Vue linting |
| **Prettier** | Code formatting |
| **pyupgrade** | Python syntax modernization |

### Running Linters

```bash
# Python linting
ruff check pospire/

# JavaScript/Vue linting
yarn lint

# Pre-commit (all checks)
pre-commit run --all-files
```

### Building Assets

```bash
# Development build with watch
bench watch

# Production build
bench build --app pospire
```

## API Reference

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `pospire.pospire.api.posapp.get_items` | Fetch items for POS |
| `pospire.pospire.api.posapp.get_customer_info` | Get customer details |
| `pospire.pospire.api.posapp.create_invoice` | Create sales invoice |
| `pospire.pospire.api.payment_entry.get_outstanding_invoices` | Get unpaid invoices |
| `pospire.pospire.api.payment_entry.submit_payment_entry` | Process payment |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes following the coding standards
4. Run linters and tests
5. Commit your changes (`git commit -m 'feat: add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Commit Message Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `style:` Code style changes (formatting)
- `refactor:` Code refactoring
- `perf:` Performance improvements
- `test:` Adding tests
- `chore:` Maintenance tasks

## Acknowledgements

POSpire is built upon [POS Awesome](https://github.com/ucraft-com/POS-Awesome) by the [Ucraft](https://github.com/ucraft-com) team. We are grateful for their foundational work that made this project possible. POSpire extends the original with additional features, UI improvements, and ongoing maintenance for Frappe/ERPNext v15.

## License

This project is licensed under the GNU General Public License v3.0 - see [LICENSE](LICENSE) for details.

POSpire is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

## Support

Need help? We have structured issue templates to get you the right assistance:

| Template | Use For |
|----------|---------|
| [Bug Report](https://github.com/promantia-ltd/POSpire/issues/new?template=bug_report.yml) | Something isn't working as expected |
| [Feature Request](https://github.com/promantia-ltd/POSpire/issues/new?template=feature_request.yml) | Suggest a new feature or enhancement |
| [Question](https://github.com/promantia-ltd/POSpire/issues/new?template=question.yml) | Ask for help or clarification |

**Before opening an issue:**
- Check [existing issues](https://github.com/promantia-ltd/POSpire/issues) to avoid duplicates
- For general Frappe/ERPNext questions, use the [ERPNext Forum](https://discuss.frappe.io/)

---

**POSpire** - Modern POS for ERPNext
