VENV := .venv
PYTHON := $(VENV)/bin/python

.PHONY: setup run test lint deploy clean

setup: $(VENV)/bin/activate

$(VENV)/bin/activate:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -e ".[dev]"

run: setup
	GPIOZERO_PIN_FACTORY=mock $(PYTHON) -m devinhackathon

test: setup
	$(PYTHON) -m pytest -q

lint: setup
	$(VENV)/bin/ruff check .

deploy:
	./scripts/deploy.sh

clean:
	rm -rf $(VENV)
