export type Role = "MEMBER" | "EDITOR" | "ADMIN";
export type AccountStatus = "PENDING" | "ACTIVE" | "SUSPENDED";
export type Visibility = "PUBLIC" | "MEMBERS";
export type ContentStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type NewsEditableStatus = Extract<ContentStatus, "DRAFT" | "PUBLISHED">;
export type QuestionType =
  "SINGLE" | "MULTIPLE" | "TRUE_FALSE" | "SHORT_ANSWER";
export type QuizQuestionCategory = "STANDARD" | "KNOWLEDGE_RECALL";
export type QuizQuestionOrigin = "MANUAL" | "CSV" | "AI_GENERATED";
export type QuizQuestionSourceFilter = "AI" | "NON_AI";
export type QuizQuestionReviewStatus = "DRAFT_REVIEW" | "APPROVED" | "REJECTED";
export type QuizQuestionSourceReviewStatus =
  "NOT_APPLICABLE" | "VALID" | "REVIEW_REQUIRED";
export type AiTaskStrategy =
  "FLASH_NO_THINKING" | "FLASH_HIGH" | "PRO_HIGH" | "PRO_MAX" | "VISION_HIGH";

export type CreditHourType = 'QUALITY' | 'VOLUNTEER';
export type CreditHourRankingType = CreditHourType | 'TOTAL';
export type AnnouncementStatus = 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';

export interface AnnouncementSummary {
  id: string;
  title: string;
  status: AnnouncementStatus;
  revision: number;
  publishedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string;
  updatedAt: string;
  readAt?: string | null;
}

export interface Announcement extends AnnouncementSummary {
  body: string;
}

export interface AnnouncementStatusResponse {
  latest: Announcement | null;
}

export interface AnnouncementPage {
  items: AnnouncementSummary[];
  nextCursor: string | null;
}

export type CreditHourSubmissionStatus =
  | 'PENDING_REVIEW'
  | 'PENDING_MANUAL_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'WITHDRAWN';
export type CreditHourReviewJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'RETRY_PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'STALE';
export type CreditHourDecisionSource =
  | 'AI'
  | 'ADMIN_OVERRIDE'
  | 'ADMIN_CREATED';

export interface AdminCreditHourCreateRequest {
  userId: string;
  type: CreditHourType;
  activityName: string;
  hours: number;
  description: string;
}

export interface AdminCreditHourBatchCreateRequest {
  type: CreditHourType;
  activityName: string;
  description: string;
  entries: Array<{ userId: string; hours: number }>;
}

export interface AdminCreditHourBatchCreateResponse {
  id: string;
  count: number;
  items: Array<{ id: string; userId: string; hours: number }>;
}

export type CreditHourManualReviewRiskCode =
  | 'OFFICIAL_SEAL_MISSING'
  | 'OFFICIAL_SEAL_UNCLEAR'
  | 'SUSPECTED_AI_GENERATION'
  | 'SUSPECTED_IMAGE_MANIPULATION'
  | 'EVIDENCE_AUTHENTICITY_UNCERTAIN';

export interface CreditHourManualReview {
  transferredAt: string | null;
  reason: string;
  riskCodes: CreditHourManualReviewRiskCode[];
}

export interface CreditHourEvidenceSummary {
  id: string;
  sortOrder: number;
  originalMimeType: string;
  originalSize: number;
  originalWidth: number;
  originalHeight: number;
  displayMimeType: string;
  displaySize: number;
  displayWidth: number;
  displayHeight: number;
  displayUrl: string;
}

export interface CreditHourSubmission {
  id: string;
  user: Pick<User, 'id' | 'displayName'>;
  type: CreditHourType;
  status: CreditHourSubmissionStatus;
  revision: number;
  activityName: string;
  hours: number;
  sourceDescription: string;
  decisionSource: CreditHourDecisionSource | null;
  decisionReason: string | null;
  manualReview?: CreditHourManualReview | null;
  evidence: CreditHourEvidenceSummary[];
  reviewJob: {
    id: string;
    reviewCycle: number;
    status: CreditHourReviewJobStatus;
    attempts: number;
    completedAt: string | null;
    updatedAt: string;
  } | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreditHourSubmissionPage = CursorPage<CreditHourSubmission>;

export interface CreditHourSummary {
  qualityHours: number;
  volunteerHours: number;
  totalHours: number;
  statusCounts: Record<string, number>;
}

export interface CreditHourLeaderboardEntry {
  userId: string;
  displayName: string;
  qualityHours: number;
  volunteerHours: number;
  totalHours: number;
  rank: number;
  currentUser: boolean;
}

export interface CreditHourLeaderboard {
  type: CreditHourRankingType;
  items: CreditHourLeaderboardEntry[];
  nextCursor: string | null;
}

export interface CreditHourPublicSubmission {
  id: string;
  type: CreditHourType;
  activityName: string;
  hours: number;
  decidedAt: string;
}

export interface CreditHourPublicSubmissionPage {
  user: Pick<User, 'id' | 'displayName'>;
  items: CreditHourPublicSubmission[];
  nextCursor: string | null;
}
export type ChapterMatch = "ANY" | "ALL";
export type QuizImportFileType = "CSV" | "ZIP";
export type QuizImportMode = "BANK" | "NEW_PAPER" | "APPEND_PAPER";
export type QuizImportStatus =
  | "PREFLIGHT_PENDING"
  | "PREFLIGHTING"
  | "AWAITING_CONFIRMATION"
  | "INVALID"
  | "IMPORT_PENDING"
  | "IMPORTING"
  | "COMPLETED"
  | "FAILED"
  | "COMPENSATION_FAILED"
  | "EXPIRED";

export interface GradingCriterion {
  description: string;
  points: number;
}

export interface GradingRubric {
  criteria: GradingCriterion[];
  notes?: string;
}

export interface QuizStartRequest {
  count?: number;
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch?: ChapterMatch;
  includeCrossChapter?: boolean;
  typeLabels?: string[];
  /** @deprecated Use typeLabels for user-facing classification. */
  types?: QuestionType[];
  source?: QuizQuestionSourceFilter;
  includePastPapers?: boolean;
  questionIds?: string[];
}

export interface CurrentUser {
  id: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
  createdAt?: string;
}

export type User = CurrentUser;

export interface Member extends CurrentUser {
  createdAt: string;
  approvedAt: string | null;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type KnowledgeKind = "ARTICLE" | "PDF" | "DOCX" | "MARKDOWN";
export type IndexStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";
export type KnowledgeRenderStatus = "PENDING" | "READY" | "FAILED";
export type KnowledgeLibraryScope = "SHARED" | "PRIVATE";
export type KnowledgeConversationMode = "SHARED" | "PRIVATE" | "COMBINED";
export type KnowledgeImportFileType = "MARKDOWN" | "ZIP";
export type KnowledgeImportStatus =
  | "PREFLIGHT_PENDING"
  | "PREFLIGHTING"
  | "INVALID"
  | "AWAITING_CONFIRMATION"
  | "INDEX_PENDING"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "COMPENSATION_FAILED"
  | "EXPIRED";

export interface Subject {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  active: boolean;
}

export interface SubjectChapter {
  id: string;
  subjectId: string;
  name: string;
  slug: string;
  sortOrder: number;
  active: boolean;
}

export interface SubjectCreateRequest {
  name: string;
  slug: string;
  sortOrder?: number;
  active?: boolean;
}

export type SubjectUpdateRequest = Partial<SubjectCreateRequest>;
export type SubjectChapterCreateRequest = SubjectCreateRequest;
export type SubjectChapterUpdateRequest = SubjectUpdateRequest;

/** @deprecated Use Subject. */
export type KnowledgeSubject = Subject;
/** @deprecated Use SubjectCreateRequest. */
export type KnowledgeSubjectCreateRequest = SubjectCreateRequest;

export interface KnowledgeDocument {
  id: string;
  title: string;
  kind: KnowledgeKind;
  indexStatus: IndexStatus;
  sourceName: string | null;
  mimeType: string | null;
  fileSize: number;
  subject: KnowledgeSubject;
  publishedAt: string | null;
  updatedAt?: string;
}

export interface NewKnowledgeChatRequest {
  question: string;
  subjectId: string;
  knowledgeMode: KnowledgeConversationMode;
  libraryIds: string[];
  libraryChapterIds?: string[];
}

export interface ContinuedKnowledgeChatRequest {
  question: string;
  conversationId: string;
}

export type KnowledgeChatRequest =
  NewKnowledgeChatRequest | ContinuedKnowledgeChatRequest;

export interface AiConversationLibrarySummary {
  id: string;
  name: string;
  scope: KnowledgeLibraryScope;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  subjectId: string | null;
  subject: Pick<Subject, 'id' | 'name'> | null;
  knowledgeMode: KnowledgeConversationMode | null;
  libraries: AiConversationLibrarySummary[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationMessage {
  id: string;
  role: string;
  content: string;
  citations: unknown;
  attachments: unknown;
  model: string | null;
  createdAt: string;
}

export interface AiConversationDetail extends AiConversationSummary {
  libraryChapters: Array<{ id: string; name: string; libraryId: string }>;
  messages: AiConversationMessage[];
  hasEarlierMessages: boolean;
}

export type AiConversationListResponse = CursorPage<AiConversationSummary>;

export interface AiConversationDeleteResult {
  id: string;
  deleted: true;
}

export interface KnowledgeLibrary {
  id: string;
  name: string;
  scope: KnowledgeLibraryScope;
  ownerId: string | null;
  subjectId: string;
  subject: Subject;
  aiEnabled: boolean;
  aiEnabledAt: string | null;
  adminDisabledAt?: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { documents: number; chapters: number };
  reader?: {
    documentCount: number;
    h2Count: number;
    contentUpdatedAt: string | null;
  };
}

export interface KnowledgeLibraryDirectoryResponse extends Page<KnowledgeLibrary> {}

export interface KnowledgeLibraryChapterOption {
  id: string;
  libraryId: string;
  name: string;
  slug: string;
  sortOrder: number;
}

export interface KnowledgeLibraryChapterOptionsResponse extends Page<KnowledgeLibraryChapterOption> {}

export interface KnowledgeImportIssue {
  id: number;
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  entryPath: string | null;
  nodePath: string | null;
  line: number | null;
  column: number | null;
  createdAt: string;
}

export interface KnowledgeImportJob {
  id: string;
  libraryId: string;
  targetDocumentId: string | null;
  fileType: KnowledgeImportFileType;
  sourceName: string;
  sourceSize: number;
  status: KnowledgeImportStatus;
  stage: string;
  progressCurrent: number;
  progressTotal: number;
  title: string | null;
  nodeCount: number;
  estimatedChunkCount: number;
  imageCount: number;
  processedImageBytes: number;
  warningCount: number;
  errorCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  confirmedVersionId: string | null;
  expiresAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeVersion {
  id: string;
  version: number;
  origin: "IMPORT" | "REINDEX";
  title: string;
  titleMarkdown: string | null;
  contentHash: string;
  imageManifestHash: string;
  indexStatus: IndexStatus;
  nodeCount: number;
  chunkCount: number;
  vectorCount: number;
  imageCount: number;
  renderStatus: KnowledgeRenderStatus;
  renderBlockVersion: string | null;
  renderBlockCount: number;
  mathCount: number;
  renderError: string | null;
  error: string | null;
  indexedAt: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

export interface KnowledgeLibraryDocument {
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: ContentStatus;
  activeVersionId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { versions: number };
}

export interface KnowledgeTreeNode {
  id: string;
  parentId: string | null;
  level: number;
  title: string;
  titleMarkdown: string | null;
  path: string;
  breadcrumb: string;
  sortOrder: number;
  libraryChapterId: string;
  _count: { chunks: number; imageReferences: number };
}

export interface KnowledgeImportReplacementPreview {
  mode: "CREATE" | "REPLACE";
  targetDocumentId: string | null;
  targetDocumentTitle: string | null;
  targetDocumentCreatedAt: string | null;
  activeVersionId: string | null;
  matchedH2Titles: string[];
}

export interface KnowledgeImportStructureItem {
  level: number;
  title: string;
  titleMarkdown: string;
  path: string;
  chapterName: string;
  chunkCount: number;
}

export interface KnowledgeImportStructureResponse {
  items: KnowledgeImportStructureItem[];
  nextCursor: number | null;
  total: number;
  images: Array<{
    entryPath: string;
    altText: string;
    nodePathHash: string;
    occurrenceIndex: number;
  }>;
  titleMarkdown: string | null;
  replacement: KnowledgeImportReplacementPreview | null;
}

export interface KnowledgeReaderManifest {
  libraryId: string;
  libraryName: string;
  scope: KnowledgeLibraryScope;
  subject: Pick<Subject, "id" | "name" | "slug">;
  readerRevision: string;
  headingCount: number;
  blockCount: number;
  imageCount: number;
  firstAnchor: string | null;
  hasContent: boolean;
}

export interface KnowledgeReaderOutlineItem {
  nodeId: string;
  parentId: string | null;
  level: number;
  title: string;
  titleMarkdown: string;
  sequenceKey: string;
  previousNodeId: string | null;
  nextNodeId: string | null;
}

export interface KnowledgeReaderOutlineResponse {
  readerRevision: string;
  items: KnowledgeReaderOutlineItem[];
  nextCursor: string | null;
  total: number;
}

export interface KnowledgeReaderImage {
  sourcePath: string;
  occurrenceIndex: number;
  photoId: string;
  contentUrl: string;
  altText: string;
  width: number | null;
  height: number | null;
}

export interface KnowledgeReaderHeadingItem {
  kind: "HEADING";
  sequenceKey: string;
  nodeId: string;
  parentId: string | null;
  level: number;
  title: string;
  titleMarkdown: string;
}

export interface KnowledgeReaderBlockItem {
  kind: "BLOCK";
  sequenceKey: string;
  nodeId: string;
  renderBlockId: string;
  blockIndex: number;
  markdown: string;
  sourceHash: string;
  markdownBytes: number;
  mathCount: number;
  images: KnowledgeReaderImage[];
}

export type KnowledgeReaderRangeItem =
  KnowledgeReaderHeadingItem | KnowledgeReaderBlockItem;

export interface KnowledgeReaderRangeResponse {
  readerRevision: string;
  items: KnowledgeReaderRangeItem[];
  hasBefore: boolean;
  hasAfter: boolean;
  beforeAnchor: string | null;
  afterAnchor: string | null;
}

export interface KnowledgeHeadingPathItem {
  nodeId: string;
  level: number;
  title: string;
  titleMarkdown: string;
}

export interface KnowledgeReaderContext {
  readerRevision: string;
  anchor: string;
  nodeId: string;
  renderBlockId: string | null;
  sequenceKey: string;
  headingPath: KnowledgeHeadingPathItem[];
}

export interface KnowledgePreviewManifest {
  documentId: string;
  versionId: string;
  libraryId: string;
  libraryName: string;
  previewRevision: string;
  title: string;
  titleMarkdown: string;
  headingCount: number;
  blockCount: number;
  imageCount: number;
  firstAnchor: string | null;
}

export interface KnowledgeCitation {
  index: number;
  libraryId: string;
  libraryName: string;
  documentId: string;
  documentVersionId: string;
  libraryChapterId: string;
  nodeId: string;
  nodeTitle: string;
  nodeTitleMarkdown: string;
  headingPath: KnowledgeHeadingPathItem[];
  renderBlockId: string;
}

export interface KnowledgeImageAttachment {
  type: "image";
  photoId: string;
  url: string;
  altText: string;
  documentId: string;
  nodeId?: string;
  renderBlockId?: string;
  citationIndex?: number;
}

export interface KnowledgeDeleteResult {
  id: string;
  deleted: true;
  storageDeleted: boolean;
}

export interface KnowledgeManageDocument extends KnowledgeDocument {
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeManageResponse = ListResponse<KnowledgeManageDocument>;

export interface UpdateUserRequest {
  role?: Role;
  status?: AccountStatus;
}

export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
  requestId?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewsSummary {
  id: string;
  title: string;
  summary: string;
  bodyFormat: "HTML_V1";
  visibility: Visibility;
  status: ContentStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt?: string;
  author: Pick<CurrentUser, "id" | "displayName">;
}

export interface NewsItem extends NewsSummary {
  body: string;
}

export interface NewsWriteRequest {
  title: string;
  summary: string;
  body: string;
  visibility: Visibility;
  status?: NewsEditableStatus;
}

export interface NewsUpdateRequest extends NewsWriteRequest {
  expectedUpdatedAt?: string;
}

export interface NewsPageResponse<
  T extends NewsSummary = NewsSummary,
> extends Page<T> {}

export interface NewsVersionRequest {
  expectedUpdatedAt?: string;
}

export interface NewsDeleteResult {
  id: string;
  deleted: true;
}

export interface NewsMutationResult {
  id: string;
  title: string;
  summary: string;
  body: string;
  bodyFormat: "HTML_V1";
  visibility: Visibility;
  status: ContentStatus;
  authorId: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ForumPost {
  id: string;
  threadId?: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt?: string;
  author: Pick<CurrentUser, "id" | "displayName">;
}

export interface ForumThread {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  locked: boolean;
  hidden: boolean;
  authorId: string;
  createdAt: string;
  updatedAt?: string;
  author: Pick<CurrentUser, "id" | "displayName">;
  _count?: { posts: number };
  posts?: ForumPost[];
}

export interface ForumReport {
  id: string;
  reason: string;
  reporterId: string;
  threadId: string | null;
  postId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  reporter: Pick<CurrentUser, "id" | "displayName">;
}

export interface AuditLogItem {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
  actor: Pick<CurrentUser, "id" | "displayName"> | null;
}

export interface AuditLogPage extends ListResponse<AuditLogItem> {
  nextCursor: string | null;
}

export type InviteState = 'ACTIVE' | 'EXPIRED' | 'EXHAUSTED' | 'REVOKED';

export interface InviteItem {
  id: string;
  label: string;
  active: boolean;
  state: InviteState;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export type InviteListResponse = ListResponse<InviteItem>;

export interface PhotoItem {
  id: string;
  albumId: string | null;
  caption: string;
  mimeType: "image/webp" | string;
  size: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  createdAt: string;
  url: string;
  originalAvailable?: boolean;
}

export interface AlbumOriginalSummary {
  albumId: string;
  photoCount: number;
  originalCount: number;
  missingOriginalCount: number;
  originalBytes: number;
  canExport: boolean;
}

export interface AlbumItem {
  id: string;
  title: string;
  description: string;
  coverUrl?: string;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  photos: PhotoItem[];
}

export interface AlbumPhotoRemoveResult {
  id: string;
  removed: true;
  photoDeleted: boolean;
  objectDeleted: boolean | null;
  cleanupOperationId?: string;
  cleanupPending?: boolean;
}

/**
 * 相册列表摘要：不含照片数组，只带封面与数量；
 * 完整照片列表经 GET /albums/:id 按需加载。
 */
export interface AlbumSummary {
  id: string;
  title: string;
  description: string;
  coverUrl: string | null;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface AlbumSummaryListResponse {
  items: AlbumSummary[];
  total: number;
}

/** includePhotos=true 时的管理端相册列表响应 */
export interface AlbumListResponse {
  items: AlbumItem[];
  total: number;
}

export interface AlbumPhotoPage extends CursorPage<PhotoItem> {
  photoCount: number;
}

export interface QuizImage {
  id: string;
  caption: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
}

export interface QuizPastPaper {
  id: string;
  title: string;
  subjectId: string;
  subject: string;
  year: number | null;
}

export interface QuizQuestionSummary {
  id: string;
  /** Backward-compatible alias of gradingType. */
  type: QuestionType;
  gradingType: QuestionType;
  typeLabel: string;
  subjectId: string;
  subject: string;
  chapterIds: string[];
  chapter: string;
  chapters: SubjectChapter[];
  category: QuizQuestionCategory;
  origin: QuizQuestionOrigin;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  images: QuizImage[];
  isPastPaper: boolean;
  pastPaper: QuizPastPaper | null;
  paperOrder: number | null;
  maxScore: number;
}

export interface QuizStartResponse {
  attemptId: string;
  questions: QuizQuestionSummary[];
}

export interface QuizSubjectTypeFilter {
  label: string;
  gradingTypes: QuestionType[];
  total: number;
  randomEligibleCount: number;
  pastPaperCount: number;
}

export interface QuizPaperSummary extends QuizPastPaper {
  questionCount: number;
  retiredQuestionCount?: number;
  typeLabels?: string[];
  createdAt?: string;
}

export interface QuizChapterFilterGroup {
  chapterId: string;
  chapter: string;
  total: number;
  randomEligibleCount: number;
  pastPaperCount: number;
  types: QuizSubjectTypeFilter[];
}

export interface QuizSubjectFilterGroup {
  subjectId: string;
  subject: string;
  pastPaperCount: number;
  types: QuizSubjectTypeFilter[];
  chapters: QuizChapterFilterGroup[];
  pastPapers: QuizPaperSummary[];
}

export interface QuizFiltersResponse {
  /** Legacy flat subject list. New clients should render subjectGroups. */
  subjects: string[];
  /** Legacy grading type list. User-facing filters should use type labels. */
  types: QuestionType[];
  subjectGroups: QuizSubjectFilterGroup[];
}

export interface QuizLibraryRequest {
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch?: ChapterMatch;
  includeCrossChapter?: boolean;
  typeLabel?: string;
  source?: QuizQuestionSourceFilter;
  pastPaper?: "ALL" | "EXCLUDE" | "ONLY";
  paperId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface QuizLibraryResponse {
  items: QuizQuestionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface QuizWrongRequest {
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch?: ChapterMatch;
  includeCrossChapter?: boolean;
  typeLabel?: string;
  source?: QuizQuestionSourceFilter;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface QuizPaperListResponse {
  items: QuizPaperSummary[];
  total: number;
}

export interface QuizQuestionWriteRequest {
  gradingType: QuestionType;
  typeLabel?: string;
  subjectId: string;
  chapterIds: string[];
  category?: QuizQuestionCategory;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctAnswer: string[];
  gradingRubric?: GradingRubric;
  explanation: string;
  pastPaperId?: string;
  paperOrder?: number;
}

export interface QuizQuestionEditorData extends QuizQuestionSummary {
  contentRevision?: number;
  correctAnswer: string[];
  gradingRubric?: GradingRubric;
  explanation: string;
}

export interface QuizQuestionDeleteResult {
  id: string;
  deleted: true;
}

export interface QuizImportIssue {
  id: number;
  severity: "ERROR" | "WARNING";
  code: string;
  rowNumber: number | null;
  filePath: string | null;
  field: string | null;
  message: string;
  createdAt: string;
}

export interface QuizImportSummary {
  questionCount: number;
  imageCount: number;
  plannedChapterCount: number;
  subjects: Array<{ name: string; count: number }>;
  typeLabels: Array<{ name: string; count: number }>;
}

export interface QuizImportJob {
  id: string;
  fileType: QuizImportFileType;
  mode: QuizImportMode;
  sourceName: string;
  sourceSize: number;
  status: QuizImportStatus;
  stage: string;
  progressCurrent: number;
  progressTotal: number;
  questionCount: number;
  imageCount: number;
  warningCount: number;
  errorCount: number;
  summary: QuizImportSummary | null;
  importedCount: number;
  createdChapterCount: number;
  resultPastPaperId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  issues?: QuizImportIssue[];
  issuesTruncated?: boolean;
  resultPastPaper?: QuizPastPaper | null;
}

export type QuizImportListResponse = Page<QuizImportJob>;

export interface QuizSubmitResponse {
  score: number;
  total: number;
  results: Array<{
    questionId: string;
    correct: boolean;
    score: number;
    maxScore: number;
    correctAnswer: string[];
    explanation: string;
    feedback?: string;
    criterionScores?: Array<{
      description: string;
      awardedPoints: number;
      maxPoints: number;
      reason: string;
    }>;
  }>;
}

export type QuizResult = QuizSubmitResponse["results"][number];

export type QuizAttemptStatus =
  | 'DRAFT'
  | 'SCORING'
  | 'SUBMITTED'
  | 'SCORING_FAILED'
  | 'ABANDONED';

export type QuizAnswerMap = Record<string, string[]>;

export interface QuizAttemptLifecycle {
  attemptId: string;
  status: QuizAttemptStatus;
  revision: number;
  position: number;
  answers: QuizAnswerMap;
  questions: QuizQuestionSummary[];
  savedAt: string | null;
  expiresAt: string | null;
  abandonedAt: string | null;
  submittedAt: string | null;
  score: number | null;
  total: number;
  results: QuizResult[] | null;
  gradingError: string | null;
}

export interface QuizActiveAttemptList {
  items: QuizAttemptLifecycle[];
}

export interface QuizDraftSaveRequest {
  revision: number;
  position: number;
  answers: QuizAnswerMap;
}

export interface QuizDraftSaveResponse {
  attemptId: string;
  revision: number;
  position: number;
  savedAt: string;
  expiresAt: string;
}

export interface QuizAbandonResponse {
  attemptId: string;
  abandoned: true;
  abandonedAt?: string;
}

export interface QuizSubmitPendingResponse {
  attemptId: string;
  status: 'SCORING';
  pending: true;
}

export interface QuizSubmitCompletedResponse extends QuizSubmitResponse {
  attemptId: string;
  status: 'SUBMITTED';
  pending: false;
  submittedAt?: string | null;
}

export type QuizSubmissionResponse =
  | QuizSubmitPendingResponse
  | QuizSubmitCompletedResponse;

export interface QuizHistoryItem {
  id: string;
  score: number | null;
  total: number;
  submittedAt: string | null;
  createdAt: string;
}

export type QuizHistoryResponse = Page<QuizHistoryItem>;

/**
 * 错题来自历史答题快照。旧快照可能缺少 typeLabel/images 等新字段，
 * 这些字段在这里保持可选，渲染时必须兜底。
 */
export interface WrongQuestion extends Omit<
  QuizQuestionSummary,
  | "gradingType"
  | "typeLabel"
  | "images"
  | "isPastPaper"
  | "pastPaper"
  | "paperOrder"
> {
  gradingType?: QuestionType;
  typeLabel?: string;
  images?: QuizImage[];
  isPastPaper?: boolean;
  pastPaper?: QuizPastPaper | null;
  paperOrder?: number | null;
  correctAnswer: string[];
  explanation: string;
  lastScore?: number;
  lastWrongAnswer?: string;
  lastFeedback?: string;
  criterionScores?: QuizResult["criterionScores"];
  wrongCount: number;
  lastWrongAt: string | null;
  retired?: boolean;
}

export type QuizWrongResponse = Page<WrongQuestion>;

export type ForumThreadListResponse = Page<ForumThread>;

export interface PracticeCourseTopic {
  id: string;
  title: string;
  sessionDates: string[];
  sourceRefs: string[];
  paused: boolean;
  taughtOnOverride: string | null;
}

export type PracticeQuestionMappingStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'NEEDS_REVIEW';

export interface PracticeCourseView {
  id: string;
  subjectId: string;
  subject: { id: string; name: string; slug: string };
  termKey: string;
  startDate: string;
  examDate: string;
  enabled: boolean;
  revision: number;
  topicHash: string;
  topics: Array<PracticeCourseTopic & { taughtOn: string; availableOn: string; learned: boolean }>;
  status: 'UPCOMING' | 'ACTIVE' | 'COMPLETED' | 'PAUSED';
  eligibleQuestionCount: number;
  mappingCounts: Record<PracticeQuestionMappingStatus | 'STALE', number>;
}

export interface PracticeCurriculumResponse {
  practiceDate: string;
  initialized: boolean;
  courses: PracticeCourseView[];
}

export interface PracticeCourseUpdateRequest {
  expectedRevision: number;
  examDate?: string;
  enabled?: boolean;
  topics?: PracticeCourseTopic[];
  reason: string;
}

export interface PracticeCourseHistoryResponse {
  items: Array<{
    id: string;
    revision: number;
    snapshot: unknown;
    reason: string;
    publishedById: string;
    createdAt: string;
  }>;
}

export interface PracticeQuestionMappingView {
  questionId: string;
  courseId: string;
  question: { id: string; prompt: string; typeLabel: string; contentRevision: number };
  status: PracticeQuestionMappingStatus;
  topicIds: string[];
  reason: string | null;
  confidence: number | null;
  manual: boolean;
  revision: number;
  contentRevision: number;
  stale: boolean;
  updatedAt: string;
}

export type PracticeQuestionMappingsResponse = Page<PracticeQuestionMappingView>;

export type TeachingProgressChangeType = 'INITIAL' | 'ADD' | 'CORRECTION';
export type UserPracticeInitializationStatus =
  'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
export type DailyPracticeCycleStatus =
  'BUILDING' | 'GENERATING' | 'READY' | 'PAUSED' | 'DEGRADED' | 'FAILED';
export type DailyPracticeDayStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'READY'
  | 'LIMITED_CONTENT'
  | 'NO_CONTENT'
  | 'DEGRADED_READY'
  | 'FAILED'
  | 'PAUSED'
  | 'STARTED'
  | 'COMPLETED'
  | 'STALE';
export type DailyPracticeTodayStatus =
  | 'TERM_COMPLETED'
  | 'SERVICE_PAUSED'
  | 'INITIALIZING'
  | 'NO_TEACHING_PROGRESS'
  | 'GENERATING'
  | DailyPracticeDayStatus;
export type DailyPracticePlanTrigger =
  'AUTO' | 'ADMIN_REGENERATE' | 'ADMIN_PREVIEW';
export type DailyPracticeGenerationSource =
  'PRO_MAX' | 'PRO_HIGH' | 'FLASH_HIGH' | 'DETERMINISTIC' | 'NO_MODEL';
export type DailyPracticePlanItemSource = 'PERSONALIZED' | 'ADMIN_FIXED';
export type DailyPracticeSuggestionStatus =
  | 'PENDING'
  | 'APPLIED'
  | 'PARTIALLY_APPLIED'
  | 'NOT_APPLIED'
  | 'SUPERSEDED'
  | 'EXPIRED_SERVICE_PAUSED';
export type DailyPracticeStrategyAttemptStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type DailyPracticeIntensity = 'LIGHT' | 'STANDARD' | 'CHALLENGING';
export type DailyPracticeDataQuality = 'SUFFICIENT' | 'LIMITED' | 'NONE';

export interface DailyPracticeServiceState {
  enabled: boolean;
  paused: boolean;
  reason: string | null;
  resumesAt: string | null;
  settingsRevision: number;
}

export interface DailyPracticeLearningSummaryEntry {
  knowledgeAlias: string;
  text: string;
  evidenceRefs: string[];
}

export interface DailyPracticeLearningSummary {
  headline: string;
  overview: string;
  dataQuality: DailyPracticeDataQuality;
  strengths: DailyPracticeLearningSummaryEntry[];
  priorities: DailyPracticeLearningSummaryEntry[];
}

export interface DailyPracticePlanItem {
  ordinal: number;
  source: DailyPracticePlanItemSource;
  questionId: string;
  gradingType: QuestionType;
  typeLabel: string;
  subjectId: string;
  subject: string;
  chapterIds: string[];
  chapters: Array<Pick<SubjectChapter, 'id' | 'name' | 'slug'>>;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  images: QuizImage[];
  maxScore: number;
  reason: string;
  evidenceRefs: string[];
}

export interface DailyPracticeSuggestionPayload {
  intensity: DailyPracticeIntensity;
  desiredQuestionCount: number;
  focusSubjectIds: string[];
  focusChapterIds: string[];
  note?: string;
}

export interface DailyPracticeSuggestionRecord {
  id: string;
  targetPracticeDate: string;
  payload: DailyPracticeSuggestionPayload;
  status: DailyPracticeSuggestionStatus;
  submittedByRole: Role;
  createdAt: string;
}

export interface DailyPracticeTodayResponse {
  curriculum?: PracticeCurriculumResponse;
  practiceDate: string;
  timeZone: 'Asia/Shanghai';
  dayStartedAt: string;
  nextDayStartsAt: string;
  status: DailyPracticeTodayStatus;
  service: DailyPracticeServiceState;
  dayId: string | null;
  supplemental: boolean;
  planRevisionId: string | null;
  generationSource: DailyPracticeGenerationSource | null;
  generatedAt: string | null;
  degradedReason: string | null;
  summary: DailyPracticeLearningSummary | null;
  personalizedItems: DailyPracticePlanItem[];
  fixedItems: DailyPracticePlanItem[];
  counts: { personalized: number; fixed: number; total: number };
  attempt: {
    id: string;
    submittedAt: string | null;
    score: number | null;
    total: number;
  } | null;
  suggestion: {
    targetPracticeDate: string;
    available: boolean;
    current: DailyPracticeSuggestionRecord | null;
  };
  initialization: {
    status: UserPracticeInitializationStatus;
    appliedAttempts: number;
    totalAttempts: number;
  } | null;
}

export interface DailyPracticeStartResponse extends QuizStartResponse {
  planRevisionId: string;
}

export interface DailyPracticeHistoryItem {
  planRevisionId: string;
  practiceDate: string;
  status: DailyPracticeDayStatus;
  generationSource: DailyPracticeGenerationSource;
  generatedAt: string;
  summary: DailyPracticeLearningSummary | null;
  questionCount: number;
  fixedQuestionCount: number;
  attempt: {
    id: string;
    score: number | null;
    total: number;
    submittedAt: string | null;
  } | null;
}

export type DailyPracticeHistoryResponse = Page<DailyPracticeHistoryItem>;

export interface DailyPracticeHistoryDetail extends DailyPracticeHistoryItem {
  personalizedItems: DailyPracticePlanItem[];
  fixedItems: DailyPracticePlanItem[];
  resultSummary: Array<{
    questionId: string;
    correct: boolean;
    score: number;
    maxScore: number;
  }>;
}

export interface DailyPracticeSettingsResponse {
  enabled: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: Pick<User, 'id' | 'displayName'> | null;
  effective: DailyPracticeServiceState;
}

export interface DailyPracticeSettingsUpdateRequest {
  enabled: boolean;
  expectedRevision: number;
  reason: string;
}

export interface DailyPracticeServicePause {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  cancelledAt: string | null;
  createdAt: string;
  createdBy: Pick<User, 'id' | 'displayName'> | null;
  cancelledBy: Pick<User, 'id' | 'displayName'> | null;
}

export interface DailyPracticeServicePauseCreateRequest {
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface TeachingProgressNodeInput {
  knowledgeNodeId: string;
  firstTaughtDate: string;
}

export interface TeachingProgressNodeSnapshot {
  id: string;
  libraryId: string;
  documentId: string;
  nodePathHash: string;
  currentKnowledgeNodeId: string | null;
  title: string;
  breadcrumb: string;
  firstTaughtDate: string;
  resolved: boolean;
  remapped: boolean;
  resolvedDocumentId: string | null;
}

export interface TeachingProgressSummary {
  id: string;
  subject: Pick<Subject, 'id' | 'name' | 'slug'>;
  version: number;
  effectivePracticeDate: string;
  changeType: TeachingProgressChangeType;
  note: string | null;
  correctionReason: string | null;
  scopeHash: string;
  nodeCount: number;
  publishedBy: Pick<User, 'id' | 'displayName'> | null;
  publishedAt: string;
}

export interface TeachingProgressDetail extends TeachingProgressSummary {
  basedOnProgressId: string | null;
  nodes: TeachingProgressNodeSnapshot[];
  unresolvedNodeCount: number;
  eligibleQuestionCount: number;
}

export interface TeachingProgressPublishRequest {
  subjectId: string;
  effectivePracticeDate: string;
  changeType: TeachingProgressChangeType;
  basedOnProgressId?: string;
  expectedVersion: number;
  note?: string;
  correctionReason?: string;
  nodes: TeachingProgressNodeInput[];
}

export interface DailyPracticeFixedQuestionCandidate {
  id: string;
  gradingType: QuestionType;
  typeLabel: string;
  subjectId: string;
  subject: string;
  chapterIds: string[];
  chapters: Array<Pick<SubjectChapter, 'id' | 'name' | 'slug'>>;
  prompt: string;
  origin: Extract<QuizQuestionOrigin, 'MANUAL' | 'CSV'>;
  isPastPaper: boolean;
}

export interface DailyPracticeFixedAssignment {
  id: string;
  practiceDate: string;
  revision: number;
  basedOnAssignmentId: string | null;
  assignmentHash: string;
  note: string | null;
  publishedAt: string;
  publishedBy: Pick<User, 'id' | 'displayName'> | null;
  questions: Array<DailyPracticeFixedQuestionCandidate & { ordinal: number }>;
}

export interface DailyPracticeFixedAssignmentDetail extends DailyPracticeFixedAssignment {
  /** Newest-first bounded history summary; at most 50 assignments. */
  history: DailyPracticeFixedAssignment[];
  historyTotal: number;
}

export interface DailyPracticeFixedAssignmentPublishRequest {
  practiceDate: string;
  expectedRevision: number;
  questionIds: string[];
  note?: string;
}

export interface DailyPracticeCycleAggregate {
  practiceDate: string;
  status: DailyPracticeCycleStatus;
  baselineAt: string;
  deadlineAt: string;
  totalUsers: number;
  statusCounts: Partial<Record<DailyPracticeDayStatus, number>>;
  generationCounts: Partial<Record<DailyPracticeGenerationSource, number>>;
  progressPercent: number;
  progress?: {
    scope: 'CURRENT_ACCESS' | 'CYCLE';
    checkedAt: string;
    enqueuedUsers: number;
    missingUsers: number;
    availableUsers: number;
    aiReadyUsers: number;
    fallbackReadyUsers: number;
    nextScheduledAt: string | null;
  };
  latencyMs: { p50: number | null; p95: number | null };
  usage: { calls: number; inputTokens: string; outputTokens: string };
  gapSummary: Array<{
    subjectId: string;
    subject: string;
    nodeCount: number;
    eligibleQuestionCount: number;
  }>;
  invalidFixedQuestionCount: number;
  progressSetHash: string;
  refreezeRequestedAt: string | null;
  pool: DailyPracticeCyclePoolDiagnostics;
}

export interface DailyPracticeCycleRemappedNode {
  subjectId: string;
  title: string;
  breadcrumb: string;
  documentId: string;
  remappedFromDocumentId: string;
  firstTaughtDate: string;
}

export interface DailyPracticeCyclePoolDiagnostics {
  progressNodeCount: number;
  candidateQuestionCount: number;
  candidateTypeCounts: Partial<Record<QuestionType, number>>;
  unresolvedProgressNodeCount: number;
  remappedProgressNodeCount: number;
  /** Newest-first bounded diagnostics; at most 50 remapped nodes. */
  remappedNodes: DailyPracticeCycleRemappedNode[];
}

export interface DailyPracticeCyclePoolSummary {
  candidateQuestionCount: number;
  unresolvedProgressNodeCount: number;
  remappedProgressNodeCount: number;
  invalidFixedQuestionCount: number;
  fixedQuestionCount: number;
  gapCount: number;
}

export interface DailyPracticeCycleSummary {
  practiceDate: string;
  status: DailyPracticeCycleStatus;
  baselineAt: string;
  deadlineAt: string;
  refreezeRequestedAt: string | null;
  activeUsers: number;
  createdDays: number;
  terminalUsers: number | null;
  statusCounts: Partial<Record<DailyPracticeDayStatus, number>> | null;
  pool: DailyPracticeCyclePoolSummary;
}

export type DailyPracticeCycleListResponse = Page<DailyPracticeCycleSummary>;

export interface DailyPracticeCycleRefreezeResponse {
  practiceDate: string;
  status: DailyPracticeCycleStatus;
  refreezeRequestedAt: string;
  rebuildableDayCount: number;
  alreadyRequested: boolean;
}

export interface AdminDailyPracticeUserSummary {
  id: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
  initializationStatus: UserPracticeInitializationStatus;
  initializationProgress: number;
  todayStatus: DailyPracticeDayStatus | null;
  generationSource: DailyPracticeGenerationSource | null;
  completed: boolean;
  summaryUpdatedAt: string | null;
  suggestionStatus: DailyPracticeSuggestionStatus | null;
}

export interface AdminDailyPracticeStateEntry {
  id: string;
  subjectId: string;
  subject: string;
  label: string;
  masteryBps: number;
  attemptCount: number;
  wrongCount: number;
  nextReviewAt: string | null;
  lastPracticedAt: string | null;
}

export interface AdminDailyPracticeCandidateQuestion {
  questionId: string;
  questionAlias: string;
  gradingType: QuestionType;
  typeLabel: string;
  promptExcerpt: string;
  knowledgeAliases: string[];
  chapterAliases: string[];
  priorityScore: number;
}

export interface AdminDailyPracticeFrozenFixedQuestion {
  questionId: string;
  ordinal: number;
  gradingType: QuestionType;
  typeLabel: string;
  promptExcerpt: string;
  subjectId: string;
  subject: string;
  chapterIds: string[];
  promptHash: string;
}

export interface AdminDailyPracticeTodayPlan {
  dayId: string;
  practiceDate: string;
  profileRevision: number;
  progressSetHash: string;
  candidateHash: string | null;
  inputHash: string | null;
  outputHash: string | null;
  candidateQuestions: AdminDailyPracticeCandidateQuestion[];
  personalizedItems: DailyPracticePlanItem[];
  fixedItems: DailyPracticePlanItem[];
  fixedAssignment: {
    assignmentId: string | null;
    hash: string;
    validCount: number;
    invalidCount: number;
    invalidQuestionIds: string[];
    questions: AdminDailyPracticeFrozenFixedQuestion[];
  } | null;
}

export interface AdminDailyPracticeUserDetail extends AdminDailyPracticeUserSummary {
  profileRevision: number;
  summary: DailyPracticeLearningSummary | null;
  /** Bounded state summary; at most 100 entries. */
  knowledgeStates: AdminDailyPracticeStateEntry[];
  knowledgeStatesTotal: number;
  /** Bounded state summary; at most 100 entries. */
  chapterStates: AdminDailyPracticeStateEntry[];
  chapterStatesTotal: number;
  todayPlan: AdminDailyPracticeTodayPlan | null;
  /** Newest-first bounded revision summary; at most 50 entries. */
  planRevisions: Array<{
    id: string;
    practiceDate: string;
    revision: number;
    trigger: DailyPracticePlanTrigger;
    generationSource: DailyPracticeGenerationSource;
    generatedAt: string;
    active: boolean;
  }>;
  planRevisionsTotal: number;
  /** Newest-first bounded suggestion summary; at most 50 entries. */
  suggestions: DailyPracticeSuggestionRecord[];
  suggestionsTotal: number;
}

export type AdminDailyPracticeUserListResponse =
  Page<AdminDailyPracticeUserSummary>;

export interface AdminDailyPracticeSuggestionRequest extends DailyPracticeSuggestionPayload {
  targetPracticeDate: string;
}

export interface AdminDailyPracticePlanActionResponse {
  dayId: string;
  practiceDate: string;
  revision: number;
  trigger: Extract<
    DailyPracticePlanTrigger,
    'ADMIN_REGENERATE' | 'ADMIN_PREVIEW'
  >;
  status: DailyPracticeDayStatus;
}

/**
 * 知识公开详情（GET /knowledge/:id）的实际返回：
 * 列表字段的子集加正文，不含 indexStatus 与 updatedAt。
 */
export type KnowledgeDocumentDetail = Pick<
  KnowledgeDocument,
  | "id"
  | "title"
  | "kind"
  | "sourceName"
  | "mimeType"
  | "fileSize"
  | "subject"
  | "publishedAt"
> & {
  body: string | null;
};
