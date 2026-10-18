# docshare

Share a PDF by link and see who read which pages, and for how long. A small, self-hosted alternative to DocSend.

Live at [docs.tung.digital](https://docs.tung.digital).

## What it does

- Upload a PDF and create one link per person or firm.
- Each link can ask for an email, allow or block download, and expire on a date.
- The viewer shows one page at a time. It records time on each page while the tab is visible.
- The document page lists every visit (email, link, time spent, pages read) and the average time per page.
- Links can be turned off at any time.

## Stack

Node.js, Express, Postgres, and [PDF.js](https://mozilla.github.io/pdf.js/). Files are stored in Postgres, so the only service it needs is a database. No build step.

## Run it

1. Create a Postgres database and set the variables in `.env.example`.
2. `npm install`
3. `npm start`, then open `/admin` and sign in with `ADMIN_PASSWORD`.

Tables are created on first start.

## Deploy on Replit

1. Import this repo into Replit.
2. Add a PostgreSQL database from the Database tool. Replit sets `DATABASE_URL`.
3. Add `ADMIN_PASSWORD` and `SESSION_SECRET` in Secrets.
4. Deploy as an Autoscale deployment. The build and run commands are in `.replit`.
5. Link a custom domain under Deployments, Settings.

## Limits

- Download blocking is a courtesy. The browser receives the PDF to display it, so a determined viewer can save it.
- Uploads are capped at 50 MB. Storing files in Postgres suits a personal library, not thousands of files.
- One admin account, set by password.

## License

MIT
