The two paths are materially different.

**Drafting**
The drafting agent is the real tool-using agent. It is invoked by the background draft worker in [`generate-draft.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/queues/generate-draft.ts:87), which loads the inbound email, inbox, thread state, and optional Entrata config, then calls [`generateDraft()`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/drafting.ts:125). Before that, the inbound body may be rewritten into a more explicit prompt for system lead forms via [`buildDraftInputBody()`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/draft-input.ts:123), e.g. “Primary inquiry to answer first: …”.

What the drafter receives:
- System prompt: default Hero drafting rules plus any active org-specific `draftingSystemPrompt` from `app_admin.prompt` in [`draft-prompt.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/draft-prompt.ts:132).
- User prompt body: built in [`buildDraftPromptMessage()`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/draft-prompt.ts:185) and includes current date, sender/subject/date metadata, generic operating rules, auto-generated verification guidance, auto-generated required-tooling guidance, “relevant internal context”, prior thread history, uploaded reference file titles, and the latest inbound message.
- Prior thread history: up to 6 earlier messages from the same thread, formatted with sender/subject/date and truncated body text, loaded in [`loadDraftRuntimeContext()`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/drafting.ts:204).
- “Relevant internal context”: `response_draft.additionalContext` for the same email if present.
- Uploaded files: only the `title` values from `draft_feedback_upload`, not file contents.
- Tools: always `writeReply`, `createTask`, `queryDocuments`, and if Entrata is configured also property/account tools like `checkAvailability`, `getFloorPlans`, `getStatus`, `createWorkOrder`, `getWorkOrders` in [`drafting.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/drafting.ts:61). It runs as a `ToolLoopAgent` with up to 8 steps.

One important nuance: the drafter is built to read `response_draft.additionalContext`, but the current worker does not write `result.additionalContext` back into `response_draft` when saving drafts in [`generate-draft.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/queues/generate-draft.ts:186). So for newly generated drafts, that field is probably usually empty unless legacy data populated it.

**Rewrite**
The rewrite path is not really an agent in the same sense. It is a plain text generation call with no tools. The UI calls `drafts.rewriteDraftStream` from [`inbox-view.tsx`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/routes/app.$organizationSlug/+/inbox-view.tsx:789), passing:
- `emailId`
- current editor contents as `draftText` if non-empty
- freeform rewrite instructions

The router in [`drafts.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/orpc/routers/drafts.ts:52) checks org ownership and blocks rewrite for non-`received-for-draft`, filtered, or non-replyable threads. Then [`loadRewriteEmailContext()`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/rewriting.ts:86) loads only:
- email body (`bodyCleanedText` or `bodyText`)
- sender header
- subject
- date sent

What the rewriter receives:
- System prompt: generic rewrite instructions in [`rewriting.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/rewriting.ts:7).
- Prompt body: current date, sender/subject/date metadata, original received message, current draft response, user rewrite instructions, `Additional internal context: None.`, and `Uploaded reference files: None.` in [`rewriting.ts`](/Users/krolebord/Projects/agent-js-feature-proper-sent-messages-ingest/web-app/app/lib/ai/rewriting.ts:31).

So the rewrite model does not get:
- thread history
- org-specific drafting prompt
- document retrieval
- Entrata tools
- stored draft metadata
- uploaded file titles/content
- any populated additional context

If you want, I can turn this into a strict “actual prompt payloads” diff for drafter vs rewriter.
