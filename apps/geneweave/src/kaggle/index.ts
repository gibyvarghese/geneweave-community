// SPDX-License-Identifier: MIT
export {
  createKaggleMCPServer,
  liveKaggleAdapter,
  fixtureKaggleAdapter,
  safeFetchKaggleOutputText,
  type KaggleAdapter,
  type KaggleCredentials,
  type KaggleMCPServerOptions,
} from './kaggle.js';

export {
  wrapAdapterWithResilience,
  __resetBreakerStateForTests,
  KaggleRateLimitError,
  getKaggleBreakerState,
} from './resilience.js';

export type {
  KaggleCompetition,
  KaggleCompetitionFile,
  KaggleCompetitionPage,
  KaggleCompetitionOverview,
  KaggleLeaderboardEntry,
  KaggleSubmission,
  KaggleDataset,
  KaggleDatasetFile,
  KaggleKernel,
  KaggleKernelOutput,
  KaggleSubmitInput,
  KaggleSubmitResult,
  KaggleKernelPushInput,
  KaggleKernelPushResult,
  KaggleDiscussionPostInput,
  KaggleDiscussionPostResult,
} from './types.js';

export {
  validateSubmissionCsv,
  type ValidateSubmissionInput,
  type ValidateSubmissionResult,
} from './validate.js';

export {
  createKaggleLocalTools,
  kaggleRunnerImagePolicyEntry,
  KAGGLE_RUNNER_IMAGE_DIGEST,
  KAGGLE_RUNNER_LIMITS,
  type KaggleLocalTools,
  type KaggleLocalToolsOptions,
  type ScoreCvInput,
  type ScoreCvResult,
  type ValidateSubmissionContainerInput,
  type ValidateSubmissionContainerResult,
  type BlendInput,
  type BlendResult,
  type BlendMetric,
  type AdversarialValidationInput,
  type AdversarialValidationResult,
} from './local-tools.js';
