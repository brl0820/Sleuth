// Buscas com progresso: rodam em segundo plano e o app consulta o andamento (/search/start e /search/poll).
import crypto from 'node:crypto';

const MAX_RESULTS = 100;

export function createJobs({ search, labels = {}, active = null, statusOf = null, actionOf = null, ttlMs = 10 * 60 * 1000, max = 20, now = Date.now }) {
    const nameOf = id => (typeof labels === 'function' ? labels(id) : labels[id]) || id;
    const jobs = new Map();
    const sweep = () => {
        for (const [id, j] of jobs) if (now() - j.touched > ttlMs) jobs.delete(id);
        while (jobs.size > max) jobs.delete(jobs.keys().next().value);
    };
    const fold = (job, line) => {
        if (Array.isArray(line.sources)) for (const id of line.sources) if (!job.sources.has(id)) job.sources.set(id, { status: 'waiting', count: 0 });
        if (line.done) { job.sources.set(line.done, { status: String(line.status || 'ok'), count: Number(line.count) || 0 }); if (Array.isArray(line.results)) job.results = line.results; }
        if (line.final) { if (Array.isArray(line.final.results)) job.results = line.final.results; job.finish = true; }
        if (line.error) { job.error = String(line.error).slice(0, 200); job.finish = true; }
        job.rev++;
    };
    async function run(job, q, mode, lang) {
        try {
            const res = await search(q, mode, lang);
            const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
            if (!/ndjson/.test(type)) {
                const out = JSON.parse(await res.text());
                const meta = out.meta || {};
                for (const id of (active ? active(mode) : Object.keys(meta))) fold(job, { done: id, status: (statusOf && statusOf(id)) || 'ok', count: Number(meta[id]) || 0 });
                fold(job, { final: { results: out.results } });
            } else {
                let buf = '';
                const dec = new TextDecoder();
                for await (const chunk of res.body) {
                    buf += dec.decode(chunk, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const text = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                        if (text) { try { fold(job, JSON.parse(text)); } catch {} }
                    }
                }
                if (buf.trim()) { try { fold(job, JSON.parse(buf)); } catch {} }
            }
        } catch (e) {
            job.error = String((e && e.message) || e).slice(0, 200);
        }
        job.done = true; job.rev++; job.touched = now();
    }
    return {
        start(q, mode, lang = '') {
            sweep();
            const id = crypto.randomBytes(9).toString('hex');
            const job = { rev: 1, done: false, error: '', finish: false, sources: new Map(), results: [], touched: now() };
            jobs.set(id, job);
            run(job, q, mode, lang);
            return { job: id };
        },
        poll(id, rev) {
            const job = jobs.get(id);
            if (!job) return null;
            job.touched = now();
            const out = {
                rev: job.rev, done: job.done,
                sources: [...job.sources].map(([sid, s]) => {
                    const status = job.done && s.status === 'waiting' ? 'timeout' : s.status, action = actionOf && actionOf(sid, status);
                    return { id: sid, name: nameOf(sid), status, count: s.count, ...(action ? { action } : {}) };
                }),
            };
            if (job.error) out.error = job.error;
            if (rev !== job.rev) out.results = job.results.slice(0, MAX_RESULTS);
            return out;
        },
        size: () => jobs.size,
    };
}
