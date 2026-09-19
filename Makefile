# review-md — one target per check; CI calls these same targets (local == CI parity).
.PHONY: help install hooks build dev typecheck secrets secrets-all precommit check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install node deps
	npm install

hooks: ## Install git pre-commit hooks
	pre-commit install

build: ## Type-check and build the plugin bundle
	npm run build

dev: ## Watch-build the plugin bundle
	npm run dev

typecheck: ## Type-check only
	npm run typecheck

secrets: ## Scan STAGED changes for secrets (what the pre-commit hook runs)
	gitleaks git --pre-commit --staged --redact --verbose

secrets-all: ## Scan the whole working tree for secrets
	gitleaks dir . --redact --verbose

precommit: ## Run all pre-commit hooks against all files
	pre-commit run --all-files

env-restore: ## Restore .env.keys from LastPass (requires `lpass login`)
	@printf 'DOTENV_PRIVATE_KEY="%s"\n' \
		"$$(lpass show 'dotenvx/review-md/DOTENV_PRIVATE_KEY' --password | tr -d '\r\n')" \
		> .env.keys && chmod 600 .env.keys && echo "restored .env.keys from LastPass (chmod 600)"

check: typecheck secrets-all ## Run the full local gate
