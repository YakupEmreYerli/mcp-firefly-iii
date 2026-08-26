# Makefile for firefly-mcp project
.PHONY: help test run check smoke inspector docs-serve docs-build docs-deploy clean

# Default target
help:
	@echo "Available commands:"
	@echo "  test             - Run the test suite (uses .env.test)"
	@echo "  run              - Run the MCP server with .env"
	@echo "  check            - Verify the live Firefly III connection"
	@echo "  smoke            - Maintainer: walk every read operation against live Firefly III"
	@echo "  inspector        - Open MCP Inspector against this server"
	@echo "  docs-serve       - Serve documentation locally"
	@echo "  docs-build       - Build documentation"
	@echo "  docs-deploy      - Deploy documentation to GitHub Pages"
	@echo "  clean            - Clean up generated files"
	@echo ""
	@echo "Pass Vitest flags with ARGS variable:"

# Test commands
test:
	npm test $(ARGS)

# Run the MCP server (stdio) against the instance configured in .env
run:
	npm run build && npm run start

# Smoke-test the live connection and the MCP tool surface
check:
	npm run build && npm run check

# Maintainer only: walks every read operation against the live instance.
# Read-only, and not part of the published package.
smoke:
	npm run smoke:live

# Interactive tool explorer in the browser
inspector:
	npm run build && npx @modelcontextprotocol/inspector node dist/index.js

# Documentation commands
#
# The docs site is built with MkDocs, which is Python. The server itself needs
# no Python at all, so the toolchain lives in a throwaway virtualenv rather than
# in the project's dependencies. CI deploys the site; these targets are for
# working on it locally.
DOCS_VENV := .venv-docs
DOCS_PY := $(DOCS_VENV)/bin/python

$(DOCS_VENV):
	python3 -m venv $(DOCS_VENV)
	$(DOCS_PY) -m pip install --quiet --upgrade pip
	$(DOCS_PY) -m pip install --quiet -r docs/requirements.txt

docs-serve: $(DOCS_VENV)
	$(DOCS_PY) -m mkdocs serve

docs-build: $(DOCS_VENV)
	$(DOCS_PY) -m mkdocs build --strict

docs-deploy: $(DOCS_VENV)
	$(DOCS_PY) -m mkdocs gh-deploy --force

# Clean up
clean:
	rm -rf dist/
	rm -rf site/
	rm -rf $(DOCS_VENV)
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
