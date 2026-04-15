# Custom PM Skills

Drop your own skills here. Each skill needs its own subdirectory with a `SKILL.md` file.

## Format

```
custom/
  my-skill-name/
    SKILL.md
```

## SKILL.md frontmatter

```markdown
---
name: my-skill-name
description: One-line description of what this skill does
path: discovery  # discovery | competitor | synthesis | all
---

You are a PM expert in...

$ARGUMENTS
```

The skill auto-appears in the UI and CLI next time the server starts.