export { ProtocolError, type ErrorCode } from "./error.js";
export { Issuer, Verifier, CLAIM, PROFILE, MAX_DATE, MAX_POSITION, DEFAULT_LIMITS, position,
  type CommittedEvidenceInput, type IssuerTrust, type Limits, type VerifiedEvidence } from "./evidence.js";
export { Snapshot, sourceKey, type Frontier, type Mapping, type Outcome, type Evaluation } from "./prefix.js";
export { parseContext, serializeContext, requestHeaders, contextHeaders, acceptConfirmation, observe, capabilities, fetchObservation,
  type Representation, type ObservationOptions, type ObservationFetchOptions, type ObservationResult, type FailureProblem } from "./http.js";
