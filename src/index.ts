export {
  acceptConfirmation,
  contextHeaders,
  type FailureProblem,
  fetchObservation,
  type ObservationFetchOptions,
  type ObservationResult,
  type ObservationWaitOptions,
  parseContext,
  requestHeaders,
  serializeContext,
  waitForObservation,
} from "./client/index.js";
export {
  type ErrorCode,
  ObservationError,
  type ObservationErrorCode,
  type ObservationPhase,
  ProtocolError,
} from "./protocol/error.js";
export {
  CLAIM,
  type CommittedEvidenceInput,
  Issuer,
  type IssuerTrust,
  MAX_DATE,
  MAX_POSITION,
  PROFILE,
  position,
  retainedContextIndices,
  type VerifiedEvidence,
  Verifier,
} from "./protocol/evidence.js";
export { DEFAULT_LIMITS, type Limits } from "./protocol/limits.js";
export {
  type Evaluation,
  type Frontier,
  type Mapping,
  type Outcome,
  Snapshot,
  sourceKey,
} from "./protocol/prefix.js";
export {
  handleNodeObservation,
  hasCausalRequirement,
  headersFromIncoming,
  type NodeObservationOptions,
  writeFetchResponse,
} from "./server/node.js";
export {
  capabilities,
  type ObservationOptions,
  observe,
  type Representation,
} from "./server/observation.js";
