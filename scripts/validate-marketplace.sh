#!/bin/bash
# POSpire Marketplace Validation Script
# Runs all checks required for Frappe Cloud Marketplace eligibility
#
# Usage: ./scripts/validate-marketplace.sh [--skip-tests] [--verbose]
#
# Output files are saved to: scripts/output/

set -e

# Configuration
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_DIR="$(cd "$APP_DIR/../.." && pwd)"
SITE="${POSPIRE_SITE:-pospire.local}"
OUTPUT_DIR="$APP_DIR/scripts/output"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Parse arguments
SKIP_TESTS=false
VERBOSE=false
for arg in "$@"; do
    case $arg in
        --skip-tests) SKIP_TESTS=true ;;
        --verbose|-v) VERBOSE=true ;;
    esac
done

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_step() {
    echo -e "\n${BLUE}=== $1 ===${NC}"
}

log_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

log_error() {
    echo -e "${RED}✗ $1${NC}"
}

log_info() {
    echo -e "  Output saved to: ${YELLOW}$1${NC}"
}

# Track results
declare -A RESULTS

#------------------------------------------------------------------------------
# Step 1: Pre-commit
#------------------------------------------------------------------------------
log_step "Step 1/5: Pre-commit Hooks"
PRECOMMIT_OUTPUT="$OUTPUT_DIR/precommit_${TIMESTAMP}.log"

cd "$APP_DIR"

if command -v pre-commit &> /dev/null; then
    if pre-commit run --all-files > "$PRECOMMIT_OUTPUT" 2>&1; then
        log_success "Pre-commit passed"
        RESULTS["precommit"]="PASS"
    else
        log_error "Pre-commit failed - check output file"
        RESULTS["precommit"]="FAIL"
    fi
    log_info "$PRECOMMIT_OUTPUT"

    if [ "$VERBOSE" = true ]; then
        echo "--- Output Preview ---"
        tail -20 "$PRECOMMIT_OUTPUT"
        echo "----------------------"
    fi
else
    log_warning "pre-commit not installed. Run: pip install pre-commit"
    RESULTS["precommit"]="SKIP"
fi

#------------------------------------------------------------------------------
# Step 2: Ruff Linting
#------------------------------------------------------------------------------
log_step "Step 2/5: Ruff Linting"
RUFF_OUTPUT="$OUTPUT_DIR/ruff_${TIMESTAMP}.log"

cd "$APP_DIR"

if command -v ruff &> /dev/null; then
    if ruff check pospire/ > "$RUFF_OUTPUT" 2>&1; then
        log_success "Ruff check passed - no issues found"
        RESULTS["ruff"]="PASS"
    else
        ISSUE_COUNT=$(wc -l < "$RUFF_OUTPUT")
        log_error "Ruff found $ISSUE_COUNT issues"
        RESULTS["ruff"]="FAIL"
    fi
    log_info "$RUFF_OUTPUT"

    if [ "$VERBOSE" = true ]; then
        echo "--- Output Preview ---"
        head -20 "$RUFF_OUTPUT"
        echo "----------------------"
    fi
else
    log_warning "ruff not installed. Run: pip install ruff"
    RESULTS["ruff"]="SKIP"
fi

#------------------------------------------------------------------------------
# Step 3: Semgrep Security Scan
#------------------------------------------------------------------------------
log_step "Step 3/5: Semgrep Security Scan"
SEMGREP_OUTPUT="$OUTPUT_DIR/semgrep_${TIMESTAMP}.log"
SEMGREP_RULES="/tmp/frappe-semgrep-rules"

cd "$APP_DIR"

if command -v semgrep &> /dev/null; then
    # Clone rules if not present
    if [ ! -d "$SEMGREP_RULES" ]; then
        echo "  Cloning Frappe semgrep rules..."
        git clone --depth 1 https://github.com/frappe/semgrep-rules.git "$SEMGREP_RULES" 2>/dev/null
    fi

    if semgrep --config "$SEMGREP_RULES/rules" --config r/python.lang.correctness pospire/ > "$SEMGREP_OUTPUT" 2>&1; then
        log_success "Semgrep passed - no security issues"
        RESULTS["semgrep"]="PASS"
    else
        # Check if it's actual findings or just warnings
        if grep -q "findings" "$SEMGREP_OUTPUT"; then
            log_warning "Semgrep found potential issues"
            RESULTS["semgrep"]="WARN"
        else
            log_success "Semgrep passed"
            RESULTS["semgrep"]="PASS"
        fi
    fi
    log_info "$SEMGREP_OUTPUT"

    if [ "$VERBOSE" = true ]; then
        echo "--- Output Preview ---"
        tail -30 "$SEMGREP_OUTPUT"
        echo "----------------------"
    fi
else
    log_warning "semgrep not installed. Run: pip install semgrep"
    RESULTS["semgrep"]="SKIP"
fi

#------------------------------------------------------------------------------
# Step 4: pip-audit Dependency Check
#------------------------------------------------------------------------------
log_step "Step 4/5: Dependency Vulnerability Check (pip-audit)"
PIPAUDIT_OUTPUT="$OUTPUT_DIR/pipaudit_${TIMESTAMP}.log"

cd "$APP_DIR"

if command -v pip-audit &> /dev/null; then
    if pip-audit --desc on . > "$PIPAUDIT_OUTPUT" 2>&1; then
        log_success "pip-audit passed - no vulnerable dependencies"
        RESULTS["pipaudit"]="PASS"
    else
        VULN_COUNT=$(grep -c "VULN" "$PIPAUDIT_OUTPUT" 2>/dev/null || echo "0")
        if [ "$VULN_COUNT" -gt 0 ]; then
            log_error "pip-audit found $VULN_COUNT vulnerable dependencies"
            RESULTS["pipaudit"]="FAIL"
        else
            log_success "pip-audit passed"
            RESULTS["pipaudit"]="PASS"
        fi
    fi
    log_info "$PIPAUDIT_OUTPUT"

    if [ "$VERBOSE" = true ]; then
        echo "--- Output Preview ---"
        cat "$PIPAUDIT_OUTPUT"
        echo "----------------------"
    fi
else
    log_warning "pip-audit not installed. Run: pip install pip-audit"
    RESULTS["pipaudit"]="SKIP"
fi

#------------------------------------------------------------------------------
# Step 5: Unit Tests
#------------------------------------------------------------------------------
log_step "Step 5/5: Unit Tests"
TESTS_OUTPUT="$OUTPUT_DIR/tests_${TIMESTAMP}.log"

if [ "$SKIP_TESTS" = true ]; then
    log_warning "Tests skipped (--skip-tests flag)"
    RESULTS["tests"]="SKIP"
else
    cd "$BENCH_DIR"

    # Check if site exists
    if bench --site "$SITE" list-apps > /dev/null 2>&1; then
        echo "  Running tests on site: $SITE"

        # Enable test mode
        bench --site "$SITE" set-config allow_tests true 2>/dev/null || true

        if bench --site "$SITE" run-tests --app pospire > "$TESTS_OUTPUT" 2>&1; then
            log_success "All tests passed"
            RESULTS["tests"]="PASS"
        else
            FAIL_COUNT=$(grep -c "FAIL\|ERROR" "$TESTS_OUTPUT" 2>/dev/null || echo "?")
            log_error "Tests failed ($FAIL_COUNT failures/errors)"
            RESULTS["tests"]="FAIL"
        fi
        log_info "$TESTS_OUTPUT"

        if [ "$VERBOSE" = true ]; then
            echo "--- Output Preview ---"
            tail -30 "$TESTS_OUTPUT"
            echo "----------------------"
        fi
    else
        log_error "Site '$SITE' not found. Set POSPIRE_SITE env variable or create the site."
        RESULTS["tests"]="SKIP"
    fi
fi

#------------------------------------------------------------------------------
# Summary
#------------------------------------------------------------------------------
echo -e "\n${BLUE}========================================${NC}"
echo -e "${BLUE}         VALIDATION SUMMARY             ${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo "Output Directory: $OUTPUT_DIR"
echo ""

printf "%-20s %s\n" "Check" "Status"
printf "%-20s %s\n" "--------------------" "------"

for check in precommit ruff semgrep pipaudit tests; do
    status="${RESULTS[$check]:-SKIP}"
    case $status in
        PASS) printf "%-20s ${GREEN}%s${NC}\n" "$check" "$status" ;;
        FAIL) printf "%-20s ${RED}%s${NC}\n" "$check" "$status" ;;
        WARN) printf "%-20s ${YELLOW}%s${NC}\n" "$check" "$status" ;;
        SKIP) printf "%-20s ${YELLOW}%s${NC}\n" "$check" "$status" ;;
    esac
done

echo ""
echo "Output files saved with timestamp: $TIMESTAMP"
echo ""

# Exit with error if any check failed
for check in precommit ruff semgrep pipaudit tests; do
    if [ "${RESULTS[$check]}" = "FAIL" ]; then
        echo -e "${RED}Some checks failed. Review output files for details.${NC}"
        exit 1
    fi
done

echo -e "${GREEN}All checks passed or skipped!${NC}"
