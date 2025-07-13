# Deployment Guide - Salesforce Flow Analyzer

## Environment Variables for Render

When deploying to Render, you need to set these environment variables in the Render dashboard:

### Required Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `production` | Set the application to production mode |
| `PORT` | (auto-set by Render) | The port Render assigns to your service |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` | Production Salesforce login URL |
| `SALESFORCE_SANDBOX_URL` | `https://test.salesforce.com` | Sandbox Salesforce login URL |
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
- **Sandbox Support** - The app now supports both production and sandbox environments via a checkbox in the UI

### Connected App Callback URLs

Make sure your Salesforce Connected App has both URLs configured:
- Development: `http://localhost:3000/auth/callback`
- Production: `https://YOUR_APP_NAME.onrender.com/auth/callback`

### Sandbox and Production Support

The application now supports connecting to both production and sandbox Salesforce environments:

#### How It Works
- **UI Checkbox**: Users can check "Connect to Sandbox Environment" before logging in
- **Dynamic URL Selection**: The app automatically uses the appropriate login URL based on the checkbox
- **Environment Variables**: Both `SALESFORCE_LOGIN_URL` and `SALESFORCE_SANDBOX_URL` are configured

#### User Experience
1. User enters their Connected App credentials
2. User checks the "Connect to Sandbox Environment" checkbox if connecting to a sandbox
3. App redirects to the appropriate Salesforce login URL:
   - **Unchecked**: `https://login.salesforce.com` (production)
   - **Checked**: `https://test.salesforce.com` (sandbox)

#### Connected App Requirements
Your Salesforce Connected App must be configured to work with both environments:
- **Production orgs**: Use the same Connected App from your production org
- **Sandbox orgs**: The Connected App should be available in your sandbox (either created there or deployed from production)

## Deployment Checklist

- [ ] Repository pushed to GitHub
- [ ] `.gitignore` excludes sensitive files (.env, node_modules, logs)
- [ ] `render.yaml` configuration file present
- [ ] Environment variables set in Render dashboard
- [ ] Connected App updated with production callback URL
- [ ] First deployment successful
- [ ] Test OAuth flow in production with production org
- [ ] Test OAuth flow with sandbox org using the checkbox
- [ ] Test flow analysis functionality in both environments
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