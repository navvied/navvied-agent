#!/bin/bash
# The agent knows nothing of the fixtures, so this only needs bun and the run's secret.
bun "$BENCH_FIXTURES/computer-solve.ts" refused-next
