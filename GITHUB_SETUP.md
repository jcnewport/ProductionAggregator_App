# GitHub Setup — ProductionAggregator_App

Follow these steps to push this project to GitHub. You only need to do this once.

## Step 1: Create the GitHub Repo

1. Go to https://github.com/new
2. Repository name: **ProductionAggregator_App**
3. Description: "Production data intake and export app for Stewardship.IS"
4. Set to **Private**
5. Do NOT check "Add a README" (we already have one)
6. Click **Create repository**

## Step 2: Push Your Code

Open Terminal on your Mac and run these commands one at a time:

```bash
# Navigate to the project folder
cd ~/Documents/Claude/Projects/ProductionAggregator_App

# Initialize git
git init

# Add all files
git add .

# Make the first commit
git commit -m "Phase 1: Initial repo structure + Supabase schema"

# Connect to your GitHub repo
git remote add origin https://github.com/jcnewport/ProductionAggregator_App.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 3: Verify

Go to https://github.com/jcnewport/ProductionAggregator_App and confirm your files are there.

## Important: Environment Files

The `.env` files are in `.gitignore` and will NOT be pushed to GitHub (this is correct — they contain secrets). You'll set those up separately in Railway and your local environment.
