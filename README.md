# Salesforce Flow Analyzer

A web application that allows Salesforce administrators to authenticate with their Salesforce org and automatically capture all flow metadata into a comprehensive JSON file and generate detailed HTML reports.

## Features

- 🔐 **Secure OAuth Authentication** - Login using your Salesforce credentials
- 🔍 **Complete Flow Analysis** - Extracts all active flows with detailed metadata
- 🤖 **AI-Powered Analysis** - Get intelligent insights and improvement recommendations
- 📊 **JSON Export** - Download all flow data as structured JSON
- 🌐 **Web Interface** - Easy-to-use dashboard for analysis and exports
- ⚡ **Enterprise Scale** - Ultra-conservative chunking for large orgs (50+ flows)
- 🎯 **Dynamic Credentials** - Enter your Connected App credentials directly in the UI

## Prerequisites

- Node.js (v14 or higher)
- A Salesforce org with System Administrator access
- A Salesforce Connected App (setup instructions below)

## Setup Instructions

### 1. Create a Salesforce Connected App

1. Log in to your Salesforce org
2. Go to **Setup** → **Apps** → **App Manager**
3. Click **New Connected App**
4. Fill in the required fields:
   - **Connected App Name**: `Salesforce Flow Analyzer`
   - **API Name**: `Salesforce_Flow_Analyzer`
   - **Contact Email**: Your email address
5. Enable OAuth Settings:
   - ✅ **Enable OAuth Settings**
   - **Callback URL**: `http://localhost:3000/auth/callback`
   - **Selected OAuth Scopes**: 
     - Access and manage your data (api)
     - Perform requests on your behalf at any time (refresh_token, offline_access)
6. Click **Save**
7. Click **Continue**
8. Copy the **Consumer Key** and **Consumer Secret** (you'll need these for the .env file)

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit the `.env` file with your Connected App details:
```env
SALESFORCE_CLIENT_ID=your_consumer_key_here
SALESFORCE_CLIENT_SECRET=your_consumer_secret_here
SALESFORCE_REDIRECT_URI=http://localhost:3000/auth/callback
PORT=3000
SALESFORCE_LOGIN_URL=https://login.salesforce.com
```

> **Note**: Use `https://test.salesforce.com` for sandbox orgs

### 4. Start the Application

```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

## Usage

1. Open your browser and navigate to `http://localhost:3000`
2. Enter your **Consumer Key** and **Consumer Secret** from your Connected App
3. Click **"Login with Salesforce"**
4. Authenticate with your Salesforce credentials
5. You'll be redirected to the dashboard
6. Configure AI analysis by clicking **"Configure AI"** and enter your AI provider API key
7. Click **"Analyze Flows"** to start the analysis
8. Once complete, you can:
   - **Export JSON**: Download all flow metadata as JSON
   - View **AI Analysis**: Get intelligent recommendations for flow improvements

## Output Files

### JSON Export (`all-flows-detailed.json`)
Contains comprehensive flow metadata including:
- Flow basic information (name, type, status, etc.)
- Creation and modification details
- Complete flow metadata (elements, connections, variables, etc.)
- Organization information

### AI Analysis Results
Get intelligent insights including:
- **Organization Overview**: Global flow architecture analysis
- **Individual Flow Analysis**: Business descriptions in simple terms and specific improvement recommendations
- **Must-Have vs Nice-to-Have**: Prioritized improvement opportunities with time estimates
- **Potential Risks**: Security, performance, and data integrity concerns
- **Organization-wide Improvements**: Strategic recommendations for flow architecture

## API Endpoints

- `GET /` - Home page
- `POST /auth/set-credentials` - Set dynamic Connected App credentials
- `GET /auth/salesforce` - Initiate Salesforce OAuth flow
- `GET /auth/callback` - OAuth callback handler
- `GET /dashboard` - Analysis dashboard
- `GET /api/flows` - Get all flows data (JSON)
- `GET /api/flows/export` - Export flows as JSON file
- `POST /api/flows/ai-analysis` - Perform AI analysis on flows
- `POST /api/flows/chat` - Follow-up questions about analysis
- `POST /auth/logout` - Logout and clear session

## Troubleshooting

### Common Issues

1. **"Invalid client_id" error**
   - Verify the Consumer Key in your .env file
   - Ensure the Connected App is saved and deployed

2. **"Redirect URI mismatch" error**
   - Check that the Callback URL in your Connected App matches the REDIRECT_URI in .env
   - Ensure you're using the correct port (default: 3000)

3. **"Insufficient privileges" error**
   - Ensure you have System Administrator permissions
   - Verify the Connected App has the correct OAuth scopes

4. **"Cannot fetch flows" error**
   - Check your internet connection
   - Verify the Salesforce org is accessible
   - Ensure the user has API access

### Development

To run in development mode with auto-reload:
```bash
npm run dev
```

## Deployment to Render (Free)

### Quick Deploy to Render

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git push -u origin main
   ```

2. **Deploy on Render:**
   - Go to [render.com](https://render.com) and sign up/login
   - Click **"New"** → **"Web Service"**
   - Connect your GitHub repository
   - Render will auto-detect the Node.js app and use `render.yaml` configuration

3. **Set Environment Variables in Render Dashboard:**
   - `SALESFORCE_REDIRECT_URI`: `https://YOUR_APP_NAME.onrender.com/auth/callback`
   - `SALESFORCE_CLIENT_ID`: Your Connected App Consumer Key
   - `SALESFORCE_CLIENT_SECRET`: Your Connected App Consumer Secret

4. **Update Connected App:**
   - In Salesforce Setup → App Manager → Your Connected App
   - Add the new callback URL: `https://YOUR_APP_NAME.onrender.com/auth/callback`

5. **Deploy!** - Your app will be live at `https://YOUR_APP_NAME.onrender.com`

### Alternative: Manual Production Deployment

For other hosting providers:
1. Set `NODE_ENV=production` in your environment
2. Use a proper session store (Redis, database) instead of in-memory storage
3. Configure HTTPS and proper security headers
4. Update the Connected App callback URL to match your production domain

## Security Considerations

- The application stores authentication tokens temporarily in memory
- For production use, implement proper session management
- Use HTTPS in production environments
- Regularly rotate your Connected App secrets
- Follow Salesforce security best practices

## License

MIT License - See LICENSE file for details

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Support

For issues and questions:
1. Check the troubleshooting section above
2. Review Salesforce Connected App documentation
3. Check Node.js and npm versions
4. Verify environment variable configuration