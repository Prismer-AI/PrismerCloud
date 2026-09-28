# Imported Office resources

The docx, pdf, powerpoint and xlsx resource trees derive from NousResearch/hermes-agent
skills/productivity at commit 1a1f4a59e252e1dc0137e7b2e7bcc8b0381d19c4.
Their individual LICENSE files are retained unchanged (MIT, 2026); upstream entry
documents are retained as GUIDE.md under each format directory. Existing Prismer
document-generation resources and aliases remain in place.

Prismer modifications: bounded original-text replacements, revision-aware reading,
relationship source isolation, comment persistence, strict template preflight,
real form flattening, attachment collision handling, Unicode font validation,
page selection/rendering limits, extraction adapters, literal CSV values,
tokenized formula references and table/dimension metadata, recursive slide edits,
independent slide background duplication and isolated renderer outputs. Regression
tests and known capability limits accompany these modifications.
