# Atajos locales (sin AWS). macOS: xgboost necesita libomp; si no está instalado
# (`brew install libomp`), se usa el libomp que trae la wheel de scikit-learn.
PY      ?= python3.12
VENV    := .venv
BIN     := $(VENV)/bin
SKL_OMP := $(wildcard $(VENV)/lib/python3*/site-packages/sklearn/.dylibs)
export DYLD_FALLBACK_LIBRARY_PATH := $(SKL_OMP)

.PHONY: setup features synthetic train test all

setup:
	$(PY) -m venv $(VENV) && $(BIN)/pip install -q -r requirements.txt

features:          ## ml/features.json desde @magicode/contracts (requiere contracts compilado)
	node ../scripts/export-scoring-features.mjs

synthetic:
	$(BIN)/python generate_synthetic.py --rows 20000 --seed 42 --out data/synthetic.csv

train:
	$(BIN)/python train.py --data data/synthetic.csv --trained-on synthetic

test:
	$(BIN)/python -m pytest -q tests

all: features synthetic train test
