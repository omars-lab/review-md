# review-md — one target per check; CI calls these same targets (local == CI parity).
.PHONY: help install hooks build dev typecheck secrets secrets-all precommit check api-docs api-check reanchor validate validate-fix

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install node deps
	npm install

hooks: ## Install git pre-commit + post-commit hooks
	pre-commit install
	pre-commit install --hook-type post-commit

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

api-docs: ## Regenerate docs/api/* from the x-callback schema
	node scripts/gen-xcallback-api.mjs

api-check: ## Fail if docs/api/* are stale vs the schema (what the pre-commit hook runs)
	node scripts/gen-xcallback-api.mjs --check

reanchor: ## Re-anchor working-copy comment threads to their commit (what the post-commit hook runs)
	node scripts/reanchor-comments.mjs

validate: ## Schema-check every comment sidecar (what the pre-commit hook runs)
	node scripts/validate-comments.mjs

validate-fix: ## Auto-repair sidecar metadata (re-quote numeric hash fields), then report
	node scripts/validate-comments.mjs --fix

precommit: ## Run all pre-commit hooks against all files
	pre-commit run --all-files

env-restore: ## Restore .env.keys from LastPass (requires `lpass login`)
	@printf 'DOTENV_PRIVATE_KEY="%s"\n' \
		"$$(lpass show 'dotenvx/review-md/DOTENV_PRIVATE_KEY' --password | tr -d '\r\n')" \
		> .env.keys && chmod 600 .env.keys && echo "restored .env.keys from LastPass (chmod 600)"

check: typecheck api-check validate secrets-all ## Run the full local gate
