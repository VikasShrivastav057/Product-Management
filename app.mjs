import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as blob from '@vercel/blob';
import { createCourseHandler } from './lib/course-server.mjs';
import { createVercelStorage } from './lib/vercel-storage.mjs';

const onVercel = process.env.VERCEL === '1';
const storagePrefix = process.env.VERCEL_ENV === 'production' ? 'pm-learning-lab/production' : 'pm-learning-lab/preview';
const storage = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? createVercelStorage(blob, { prefix: storagePrefix }) : {};
const handle = createCourseHandler({
  ...storage,
  secure: onVercel,
  accessHash: process.env.PM_ACCESS_CODE_SHA256,
  examBank: process.env.PM_EXAM_BANK,
  openAIKey: process.env.OPENAI_API_KEY,
  tutorModel: process.env.OPENAI_TUTOR_MODEL,
});

const app = express();
app.disable('x-powered-by');
app.use(async (incoming, outgoing) => {
  try {
    const scheme = onVercel || incoming.socket.encrypted ? 'https' : 'http';
    const url = new URL(`${scheme}://${incoming.headers.host || 'localhost'}${incoming.originalUrl}`);
    const method = incoming.method;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(url, { method, headers, ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
    const response = await handle(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') outgoing.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
    if (!response.body || method === 'HEAD') { outgoing.end(); return; }
    await pipeline(Readable.fromWeb(response.body), outgoing);
  } catch (error) {
    console.error('Course request could not be completed.', error?.name);
    if (outgoing.headersSent) { outgoing.destroy(); return; }
    outgoing.status(503).set('Cache-Control', 'no-store').json({ error: 'The course is temporarily unavailable. Please try again.' });
  }
});

export default app;
