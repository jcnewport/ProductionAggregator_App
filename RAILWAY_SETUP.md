# Railway Setup — ProductionAggregator_App

Follow these steps to create your Railway project and connect it to this repo.

---

## Step 1: Create a Railway Account (if you don't have one)

1. Go to **https://railway.app**
2. Click **Login** (top right)
3. Sign in with your **GitHub account** (jcnewport) — this is the easiest method because it automatically connects Railway to your repos

---

## Step 2: Create a New Railway Project

1. Once logged in, click **"New Project"** (top right of your Railway dashboard)
2. Select **"Deploy from GitHub Repo"**
3. Find and select **ProductionAggregator_App** from your repo list
   - If you don't see it, click "Configure GitHub App" to grant Railway access to the repo
4. Railway will ask which folder to deploy — select the **`api`** folder
   - This tells Railway to only build and deploy the backend, not the whole monorepo

---

## Step 3: Set Environment Variables

Once the project is created, you need to add the same variables from `api/.env.example`:

1. Click on your service in the Railway dashboard
2. Go to the **"Variables"** tab
3. Add these variables (click "New Variable" for each):

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://sdnpvclmfezesgqeudzu.supabase.co` |
| `SUPABASE_SERVICE_KEY` | *(get from Supabase dashboard — see below)* |
| `GMAIL_CLIENT_ID` | *(we'll set this up in a later step)* |
| `GMAIL_CLIENT_SECRET` | *(we'll set this up in a later step)* |
| `GMAIL_REFRESH_TOKEN` | *(we'll set this up in a later step)* |
| `GMAIL_MONITORED_EMAIL` | `S.IS_AD_Prod@stewardship.is` |
| `PORT` | `3001` |
| `NODE_ENV` | `production` |

### How to get your Supabase Service Key:
1. Go to https://supabase.com/dashboard/project/sdnpvclmfezesgqeudzu/settings/api
2. Under "Project API keys", copy the **service_role** key (the secret one — NOT the anon key)
3. Paste it as the `SUPABASE_SERVICE_KEY` value in Railway

---

## Step 4: Configure the Build

Railway should auto-detect Node.js. If it asks for build settings:

- **Root Directory:** `api`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`

---

## Step 5: Get Your Railway URL

After deployment:
1. Go to your service's **"Settings"** tab
2. Under "Networking", click **"Generate Domain"**
3. You'll get a URL like `productionaggregator-app-production.up.railway.app`
4. Save this — it's your API's live URL

---

## What Happens Next

Once Railway is running, your API's health check will be live at:
`https://your-railway-url.up.railway.app/health`

You should see: `{"status":"ok","service":"ProductionAggregator API"}`

We'll configure Gmail API and build the parsers in the next session.
