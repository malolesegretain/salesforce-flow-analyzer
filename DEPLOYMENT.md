# Deployment Guide - Salesforce Flow Analyzer

## Environment Variables for Render

When deploying to Render, you need to set these environment variables in the Render dashboard:

### Required Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `production` | Set the application to production mode |
| `PORT` | (auto-set by Render) | The port Render assigns to your service |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` | Salesforce login URL (use `https://test.salesforce.com` for sandbox) |
| `SALESFORCE_REDIRECT_URI` | `https://YOUR_APP_NAME.onrender.com/auth/callback` | OAuth callback URL (replace YOUR_APP_NAME) |
| `SALESFORCE_CLIENT_ID` | Your Consumer Key | From your Salesforce Connected App |
| `SALESFORCE_CLIENT_SECRET` | Your Consumer Secret | From your Salesforce Connected App |

### Setting Environment Variables in Render

1. Go to your service dashboard in Render
2. Click on **"Environment"** in the left sidebar
3. Click **"Add Environment Variable"**
4. Add each variable from the table above
5. Click **"Save Changes"**

### Important Notes

- **Replace `YOUR_APP_NAME`** in the redirect URI with your actual Render app name
- **Keep credentials secure** - Never commit your Client ID/Secret to GitHub
- **Update your Connected App** in Salesforce with the new production callback URL
- **For sandbox orgs** - Use `https://test.salesforce.com` as the login URL

### Connected App Callback URLs

Make sure your Salesforce Connected App has both URLs configured:
- Development: `http://localhost:3000/auth/callback`
- Production: `https://YOUR_APP_NAME.onrender.com/auth/callback`

## Deployment Checklist

- [ ] Repository pushed to GitHub
- [ ] `.gitignore` excludes sensitive files (.env, node_modules, logs)
- [ ] `render.yaml` configuration file present
- [ ] Environment variables set in Render dashboard
- [ ] Connected App updated with production callback URL
- [ ] First deployment successful
- [ ] Test OAuth flow in production
- [ ] Test flow analysis functionality
- [ ] Test AI analysis with your preferred provider

## Troubleshooting Production Issues

### OAuth Issues
- Verify callback URL matches exactly between Render and Connected App
- Check that CLIENT_ID and CLIENT_SECRET are set correctly
- Ensure Connected App is saved and deployed in Salesforce

### Application Issues
- Check Render logs for any startup errors
- Verify all environment variables are set
- Test locally first to ensure code works

### Performance Issues
- Render free tier has limitations (750 hours/month, sleeps after 15min)
- Consider upgrading to paid tier for production use
- Monitor usage in Render dashboard