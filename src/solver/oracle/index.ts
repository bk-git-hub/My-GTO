/** Independent slow reference ("oracle") for cross-checking the core solver. See docs/solver.md. */
export { oracleTree, oracleNodeAt, oracleTreeStats, forEachNode, pathKey, streetOfBoard } from "./tree";
export type { OracleNode, OracleAction } from "./tree";
export { OracleGame, oracleHands, compatible, sharesCard, chanceProbability, terminalNet0 } from "./game";
export type { OracleHand } from "./game";
export {
  oracleBestResponse,
  oracleValue,
  oracleNodeInfo,
  bestResponseOnGame,
  valueOnGame,
} from "./bestResponse";
export type { StrategyFn, OracleBestResponseResult, OracleNodeInfo } from "./bestResponse";
export { oracleSolve, createOracleCfr } from "./cfr";
export type { OracleSolveResult, OracleCfr } from "./cfr";
