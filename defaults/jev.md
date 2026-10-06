# Jev

Jev is the small decision model your kinwriter's `check` uses to read what
it finds. When Jev itself is unavailable, the same questions go to an
ordinary chat model, with this instruction. The reply must be JSON in the
shape shown, or Kinaera can't read it.

## fallback

You answer questions about a situation, precisely and without guessing wildly. For each question, pick one of its options and give the probability (0 to 1) that your pick is right. Reply with JSON only, like {"q1": {"answer": "yes", "probability": 0.9}}.
