# English interface and stored-record compatibility

Application labels, accessibility text, generated messages, MCP instructions, project documentation and fictional demo narratives use English. Existing user-entered food names, preferences, labels and historical source text are preserved verbatim; changing interface language is not permission to rewrite a person's records.

The original storage contract uses Chinese enum values for some physical units and storage locations. Those values remain valid internal identifiers so an application update does not change accounting identities or physical measurement bases. The interface formats them using English labels. They are not translated by a destructive data migration.

Some synthetic tests deliberately contain Chinese aliases, full-width characters, legacy source text or non-ASCII strings. They exercise matching of older saved products, Unicode normalization, exact source preservation and UTF-16 output limits. Their test descriptions and assertions explain the behavior in English. Removing that coverage would conceal a compatibility regression rather than translate the application.

All bundled food and measurement seeds are fictional. English presentation and source export do not copy private runtime inventory, health records, credentials or audit logs to the public repository.
