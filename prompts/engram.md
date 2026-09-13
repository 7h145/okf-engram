---
description: Use Engram project knowledge and explicit global memory
argument-hint: "[help|init|global|both|wire|unwire|mode|auto|ls|find|show|sources|inventory|remember|recall|ingest|queue|jobs|cancel|remove|<canonical-domain>] [arguments]"
---
Activate and follow the `okf-engram` skill. Treat this as a strict `/engram`
request; resolve human shortcuts through its routing table before invoking the
helper, preserve Pi's current project working directory unless the request selects
another root, interpret semantic intents through the skill rather than invoking
them as helper commands, preserve each shortcut's documented user purpose when
presenting results, and reject unknown forms with concise help.
Engram request: $ARGUMENTS
