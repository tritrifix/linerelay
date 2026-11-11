# LineRelay — raccourcis Docker.
#
#   make dev      développement local, rechargement à chaud
#   make build    construit l'image de production
#   make smoke    construit puis vérifie que l'image répond
#   make push     publie l'image sur GHCR (TAG=v1.0.0)
#   make deploy   à exécuter SUR le serveur : pull + up -d
#
# Surcharges possibles :  HOST_PORT=8080 make dev   /   TAG=v1.0.0 make push

SHELL := /bin/bash
IMAGE ?= ghcr.io/tritrifix/linerelay
TAG ?= dev
HOST_PORT ?= 3000
COMPOSE ?= docker compose

.DEFAULT_GOAL := help
.PHONY: help dev up down logs sh build smoke push deploy prod-logs prod-down clean

help: ## Affiche cette aide
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1;35m%-12s\033[0m %s\n", $$1, $$2}'

# ----------------------------------------------------------- développement --
dev: ## Démarre en dev (premier plan, rechargement à chaud)
	HOST_PORT=$(HOST_PORT) $(COMPOSE) up --build

up: ## Démarre en dev en arrière-plan
	HOST_PORT=$(HOST_PORT) $(COMPOSE) up --build -d

down: ## Arrête l'environnement de dev
	$(COMPOSE) down

logs: ## Suit les logs de dev
	$(COMPOSE) logs -f

sh: ## Ouvre un shell dans le conteneur de dev
	$(COMPOSE) exec app bash

# ------------------------------------------------------------------- image --
build: ## Construit l'image de production
	docker build -t $(IMAGE):$(TAG) .

smoke: build ## Construit puis vérifie /api/health
	@docker rm -f linerelay-smoke >/dev/null 2>&1 || true
	docker run -d --name linerelay-smoke -p $(HOST_PORT):3000 $(IMAGE):$(TAG)
	@echo "Attente de la sonde de santé…"
	@for i in $$(seq 1 30); do \
	  if curl -sf http://127.0.0.1:$(HOST_PORT)/api/health >/dev/null; then \
	    echo "OK — http://127.0.0.1:$(HOST_PORT)"; \
	    docker rm -f linerelay-smoke >/dev/null; exit 0; \
	  fi; sleep 2; \
	done; \
	echo "ÉCHEC : pas de réponse sur /api/health" >&2; \
	docker logs linerelay-smoke >&2; docker rm -f linerelay-smoke >/dev/null; exit 1

push: ## Publie l'image sur GHCR (TAG=v1.0.0 make push)
	@test "$(TAG)" != "dev" || { echo "Donnez un TAG explicite : TAG=v1.0.0 make push" >&2; exit 1; }
	docker build -t $(IMAGE):$(TAG) .
	docker push $(IMAGE):$(TAG)

# -------------------------------------------------------------- production --
deploy: ## SUR LE SERVEUR : tire l'image et redémarre
	$(COMPOSE) -f compose.prod.yaml pull
	$(COMPOSE) -f compose.prod.yaml up -d
	$(COMPOSE) -f compose.prod.yaml ps

prod-logs: ## SUR LE SERVEUR : suit les logs de production
	$(COMPOSE) -f compose.prod.yaml logs -f

prod-down: ## SUR LE SERVEUR : arrête la production
	$(COMPOSE) -f compose.prod.yaml down

clean: ## Supprime les conteneurs et images locaux de LineRelay
	-$(COMPOSE) down -v
	-docker rm -f linerelay-smoke
	-docker image rm linerelay:dev $(IMAGE):$(TAG)
