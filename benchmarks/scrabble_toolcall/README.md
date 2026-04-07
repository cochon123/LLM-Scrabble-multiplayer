# Scrabble Tool-Call Benchmark

CLI Python pour comparer des techniques de sortie structurée sur une tâche guidée de placement Scrabble.

## Ce que mesure la V1

- board donné
- rack donné
- mot cible donné
- le modèle doit rendre la position exacte des lettres

Le benchmark mesure la précision du schéma de sortie, pas la stratégie Scrabble.

## Techniques

- `placements_json`
- `board_matrix_full`
- `delta_sparse`

## Générer un dataset

```bash
python3 -m benchmarks.scrabble_toolcall.cli generate-dataset \
  --count 500 \
  --simple 200 \
  --medium 200 \
  --hard 100 \
  --out runtime-bench/scrabble-toolcall/datasets/default-500.jsonl
```

## Lancer un benchmark local OpenAI-compatible

```bash
python3 -m benchmarks.scrabble_toolcall.cli run \
  --provider openai_compatible \
  --base-url http://127.0.0.1:1234/v1/chat/completions \
  --model qwen3.5-4b \
  --dataset runtime-bench/scrabble-toolcall/datasets/default-500.jsonl \
  --techniques placements_json board_matrix_full delta_sparse \
  --concurrency 5 \
  --out runtime-bench/scrabble-toolcall/runs/local-qwen35
```

## Générer le rapport

```bash
python3 -m benchmarks.scrabble_toolcall.cli report \
  --run runtime-bench/scrabble-toolcall/runs/local-qwen35
```

## Notes

- la concurrence est plafonnée à `5`
- les détails de diff sont affichés par défaut seulement sur échec
- les graphes sont écrits dans `charts/`
