# PM Learning Lab

Study product management, SQL, and project delivery through 52 lessons and seven cases. Course chat links answers back to the lessons. The final assessment unlocks a PDF completion certificate at 80%.

Anyone can open the course. A private browser session keeps each learner's attempts, certificate, and portfolio separate.

## Hosting

The Express application runs on Node.js 24 on Vercel. Connect a private Vercel Blob store to persist assessment attempts, certificates, and portfolio files. Portfolio uploads support one file up to 4 MiB per entry.

Configure these values as Vercel environment variables.

- `PM_EXAM_BANK` is the private JSON bank of 30 questions. The source repository includes synthetic grading tests.
- `GROQ_API_KEY` enables generated tutor responses. Create a key in [GroqCloud](https://console.groq.com/keys), save it as a Production Secret in Vercel, and redeploy. Course-based answers are available before it is configured.
- `GROQ_TUTOR_MODEL` is optional and defaults to `openai/gpt-oss-20b` on Groq.

Run `npm ci` and `npm run verify` to check the server, grading, portfolio, and tutor behavior.
