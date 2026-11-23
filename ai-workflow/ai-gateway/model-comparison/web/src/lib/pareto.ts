// A point is on the Pareto frontier when no other point is at least as good on
// score and at most as costly, with one of the two strictly better. "Better"
// means higher score and lower cost.

export interface Point {
  id: string;
  cost: number;
  score: number;
}

// ParetoFrontier returns the non-dominated points, sorted by ascending cost.
export function paretoFrontier(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.cost - b.cost || b.score - a.score);
  const frontier: Point[] = [];
  let bestScore = -Infinity;
  for (const p of sorted) {
    if (p.score > bestScore) {
      frontier.push(p);
      bestScore = p.score;
    } else if (p.score === bestScore && frontier.length > 0 && frontier[frontier.length - 1].cost === p.cost) {
      // Equal-cost, equal-score models are tied rather than dominated.
      frontier.push(p);
    }
  }
  return frontier;
}
