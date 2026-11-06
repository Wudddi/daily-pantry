# Interface languages and stored-record compatibility

The public GitHub edition defaults to English. The owner's private Sites instance uses a Chinese interface. Both use the same application, calculations and accounting rules. New UI and accessibility copy is authored as English keys and localized through `uiText`; `uiLocale` selects display formatting. The Chinese dictionary is `lib/ui-zh-CN.json`, and `lib/ui-language-config.json` selects `en` or `zh-CN`. MCP instructions, public project documentation and fictional demo narratives remain English.

The checked public export always writes `{ "language": "en" }` to its destination, even when the source checkout selects Chinese. It does not edit the private configuration. The translation dictionary may be included as optional language support; its presence does not change the public English default. The shared test runner sets `PANTRY_UI_LANGUAGE=en`; dedicated locale tests use isolated processes to verify both languages.

Existing user-entered food names, preferences, labels and historical source text are preserved verbatim. Changing interface language is not permission to rewrite a person's records.

The original storage contract uses Chinese enum values for some physical units and storage locations. Those values remain valid internal identifiers so an update does not change accounting identities or measurement bases. Chinese UI uses the original labels; English UI formats English singular/plural labels. Neither uses a destructive data migration.

Some synthetic tests deliberately contain Chinese aliases, full-width characters, legacy source text or non-ASCII strings. They exercise matching of older saved products, Unicode normalization, exact source preservation and UTF-16 output limits. Their test descriptions and assertions explain the behavior in English. Removing that coverage would conceal a compatibility regression rather than translate the application.

All bundled food and measurement seeds are fictional. Localization and source export do not copy private runtime inventory, health records, credentials or audit logs to the public repository. Changing language does not change automatic-settlement authorization or deduct inventory.
