const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const jsforce = require('jsforce');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const axios = require('axios');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Store connection info temporarily (in production, use proper session management)
let connectionInfo = {};

// Store AI conversation context
let aiContext = {
    provider: null,
    apiKey: null,
    flowsData: null,
    analysisResult: null
};

// Store temporary OAuth credentials per session
let tempCredentials = {};

// AI Analysis Prompt
const AI_ANALYSIS_PROMPT = `You are a Salesforce Flow Analyst. Analyze ALL the provided flows and provide:

## Organization Overview
Write a 100-150 word overview of the global flow architecture.

## Potential Risks  
Identify risks like infinite loops, governor limits, data integrity issues.

## Organization-wide Improvements
List improvement opportunities with benefits and implementation steps.

## Individual Flow Analysis
IMPORTANT: Analyze EVERY SINGLE flow provided. Do not skip any flows due to length constraints.
For each flow:
### [Flow Name]
**Business Description:** 100-150 word description in simple terms a 12-year-old could understand
**Improvement Opportunities:** Specific improvements with benefits and implementation guidance

Requirements:
- MUST analyze every single flow provided - no exceptions
- Use simple language, avoid technical jargon
- Focus on high-impact improvements only
- Be specific about implementation (element names, when to call, etc.)
- Make recommendations actionable for Salesforce admins
- Use analogies for business descriptions
- If you encounter length limits, prioritize individual flow analysis over other sections

Flow data:
`;

// AI Service Functions
async function callOpenAI(apiKey, prompt) {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [
            {
                role: 'user',
                content: prompt
            }
        ],
        max_tokens: 8000,
        temperature: 0.7
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    
    return response.data.choices[0].message.content;
}

async function callClaude(apiKey, prompt, retryCount = 0) {
    try {
        console.log(`Claude API call - Prompt length: ${prompt.length} characters`);
        
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 8000,
            temperature: 0.3,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ]
        }, {
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01'
            },
            timeout: 120000 // 2 minute timeout
        });
        
        return response.data.content[0].text;
    } catch (error) {
        console.log(`Claude API error: ${error.response?.status} - ${error.response?.data?.error?.message || error.message}`);
        console.log(`Request payload size: ${prompt.length} characters`);
        
        // Retry on 529 (overloaded) errors
        if (error.response?.status === 529 && retryCount < 2) {
            const waitTime = Math.pow(2, retryCount) * 2000; // 2s, 4s exponential backoff
            console.log(`Claude API overloaded, retrying in ${waitTime}ms (attempt ${retryCount + 1}/3)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callClaude(apiKey, prompt, retryCount + 1);
        }
        throw error;
    }
}

async function callMistral(apiKey, prompt) {
    const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
        model: 'mistral-large-latest',
        messages: [
            {
                role: 'user',
                content: prompt
            }
        ],
        max_tokens: 8000,
        temperature: 0.7
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    
    return response.data.choices[0].message.content;
}

async function callGemini(apiKey, prompt) {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    });
    
    return response.data.candidates[0].content.parts[0].text;
}

function compressFlowData(flowsData) {
    // Create a simplified version of the flow data for AI analysis
    const compressed = {
        metadata: flowsData.metadata,
        flows: flowsData.flows.map(flow => ({
            Id: flow.Id,
            FullName: flow.FullName,
            MasterLabel: flow.MasterLabel,
            Status: flow.Status,
            ProcessType: flow.ProcessType,
            Description: flow.Metadata?.description || '',
            // Include key metadata elements but remove verbose details
            Elements: {
                assignments: flow.Metadata?.assignments?.length || 0,
                decisions: flow.Metadata?.decisions?.length || 0,
                recordCreates: flow.Metadata?.recordCreates?.length || 0,
                recordUpdates: flow.Metadata?.recordUpdates?.length || 0,
                recordLookups: flow.Metadata?.recordLookups?.length || 0,
                actionCalls: flow.Metadata?.actionCalls?.length || 0,
                loops: flow.Metadata?.loops?.length || 0,
                formulas: flow.Metadata?.formulas?.length || 0
            },
            // Include trigger information if available
            Triggers: flow.Metadata?.start ? {
                type: flow.Metadata.start.triggerType,
                object: flow.Metadata.start.object,
                conditions: flow.Metadata.start.filterLogic ? 'Has conditions' : 'No conditions'
            } : null,
            // Include key formulas/logic summaries
            FormulaCount: flow.Metadata?.formulas?.length || 0,
            VariableCount: flow.Metadata?.variables?.length || 0,
            TriggerOrder: flow.TriggerOrder,
            ApiVersion: flow.ApiVersion,
            LastModifiedDate: flow.LastModifiedDate
        }))
    };
    
    return compressed;
}

function createBalancedFlowData(flowsData) {
    // Create a balanced version that preserves key details for analysis quality
    // while staying under API limits
    const balanced = {
        metadata: {
            totalFlows: flowsData.metadata.totalFlows,
            orgAlias: flowsData.metadata.orgAlias,
            orgUsername: flowsData.metadata.orgUsername
        },
        flows: flowsData.flows.map(flow => ({
            // Basic info
            id: flow.Id,
            name: flow.MasterLabel || flow.FullName,
            fullName: flow.FullName,
            type: flow.ProcessType,
            status: flow.Status,
            description: flow.Metadata?.description || '',
            apiVersion: flow.ApiVersion,
            lastModified: flow.LastModifiedDate?.substring(0, 10),
            
            // Trigger details (essential for analysis)
            trigger: flow.Metadata?.start ? {
                type: flow.Metadata.start.triggerType,
                object: flow.Metadata.start.object,
                recordTriggerType: flow.Metadata.start.recordTriggerType,
                schedule: flow.Metadata.start.schedule,
                filters: flow.Metadata.start.filters?.map(f => ({
                    field: f.field,
                    operator: f.operator,
                    value: f.value?.stringValue || f.value?.elementReference
                })) || []
            } : null,
            
            // Element counts
            elementCounts: {
                recordUpdates: flow.Metadata?.recordUpdates?.length || 0,
                recordCreates: flow.Metadata?.recordCreates?.length || 0,
                recordLookups: flow.Metadata?.recordLookups?.length || 0,
                decisions: flow.Metadata?.decisions?.length || 0,
                assignments: flow.Metadata?.assignments?.length || 0,
                actionCalls: flow.Metadata?.actionCalls?.length || 0,
                formulas: flow.Metadata?.formulas?.length || 0,
                variables: flow.Metadata?.variables?.length || 0,
                loops: flow.Metadata?.loops?.length || 0
            },
            
            // Key elements with details (for specific recommendations)
            recordUpdates: flow.Metadata?.recordUpdates?.map(u => ({
                name: u.name,
                label: u.label,
                object: u.object,
                inputReference: u.inputReference,
                fields: u.inputAssignments?.map(a => a.field) || []
            })) || [],
            
            recordCreates: flow.Metadata?.recordCreates?.map(c => ({
                name: c.name,
                label: c.label,
                object: c.object,
                fields: c.inputAssignments?.map(a => a.field) || []
            })) || [],
            
            decisions: flow.Metadata?.decisions?.map(d => ({
                name: d.name,
                label: d.label,
                defaultConnector: d.defaultConnector?.targetReference,
                rules: d.rules?.map(r => ({
                    name: r.name,
                    label: r.label,
                    connector: r.connector?.targetReference
                })) || []
            })) || [],
            
            actionCalls: flow.Metadata?.actionCalls?.map(a => ({
                name: a.name,
                label: a.label,
                actionName: a.actionName,
                actionType: a.actionType
            })) || [],
            
            formulas: flow.Metadata?.formulas?.map(f => ({
                name: f.name,
                dataType: f.dataType,
                description: f.description,
                expression: f.expression?.substring(0, 200) + (f.expression?.length > 200 ? '...' : '')
            })) || [],
            
            variables: flow.Metadata?.variables?.map(v => ({
                name: v.name,
                dataType: v.dataType,
                isCollection: v.isCollection,
                isInput: v.isInput,
                isOutput: v.isOutput
            })) || [],
            
            // Assignments for business logic understanding
            assignments: flow.Metadata?.assignments?.map(a => ({
                name: a.name,
                label: a.label,
                assignmentItems: a.assignmentItems?.map(item => ({
                    assignToReference: item.assignToReference,
                    operator: item.operator,
                    value: item.value?.stringValue || item.value?.elementReference || 'complex_value'
                }))?.slice(0, 3) || [] // Limit to first 3 assignments
            })) || []
        }))
    };

    return balanced;
}

async function performAIAnalysis(provider, apiKey, flowsData) {
    const flows = flowsData.flows;
    const totalFlows = flows.length;
    
    console.log(`Starting analysis for ${totalFlows} flows`);
    
    // Determine if we need chunking based on data size and flow count
    const compactSize = JSON.stringify(flowsData).length;
    const shouldChunk = compactSize > 100000 || totalFlows > 15;
    
    if (!shouldChunk) {
        console.log(`Small org: Using single analysis for ${totalFlows} flows (${compactSize} chars)`);
        return await performSingleAnalysis(provider, apiKey, flowsData);
    } else {
        console.log(`Large org: Using chunked analysis for ${totalFlows} flows (${compactSize} chars)`);
        return await performChunkedAnalysis(provider, apiKey, flowsData);
    }
}

async function performSingleAnalysis(provider, apiKey, flowsData) {
    const prompt = AI_ANALYSIS_PROMPT + JSON.stringify(flowsData);
    
    let analysisText;
    switch (provider) {
        case 'openai':
            analysisText = await callOpenAI(apiKey, prompt);
            break;
        case 'claude':
            analysisText = await callClaude(apiKey, prompt);
            break;
        case 'mistral':
            analysisText = await callMistral(apiKey, prompt);
            break;
        case 'gemini':
            analysisText = await callGemini(apiKey, prompt);
            break;
        default:
            throw new Error('Unsupported AI provider');
    }
    
    console.log('=== RAW AI RESPONSE START ===');
    console.log(analysisText);
    console.log('=== RAW AI RESPONSE END ===');
    
    return parseAIAnalysis(analysisText, flowsData);
}

async function performChunkedAnalysis(provider, apiKey, flowsData) {
    const flows = flowsData.flows;
    
    // Ultra-conservative chunking for 100% reliability
    // Start with 1 flow per chunk and dynamically adjust based on data size
    const chunks = [];
    
    // Group flows by complexity/size to optimize chunking
    const flowsBySize = flows.map(flow => ({
        flow,
        estimatedSize: JSON.stringify(flow).length
    })).sort((a, b) => a.estimatedSize - b.estimatedSize);
    
    let currentChunk = [];
    let currentChunkSize = 0;
    const maxChunkSize = 15000; // Conservative limit to avoid API issues
    
    for (const { flow, estimatedSize } of flowsBySize) {
        // If adding this flow would exceed limit, start new chunk
        if (currentChunk.length > 0 && (currentChunkSize + estimatedSize > maxChunkSize || currentChunk.length >= 2)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChunkSize = 0;
        }
        
        currentChunk.push(flow);
        currentChunkSize += estimatedSize;
    }
    
    // Add remaining flows as final chunk
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    
    console.log(`Processing ${flows.length} flows in ${chunks.length} chunks (adaptive sizing for reliability)`);
    
    // Process each chunk to get detailed individual flow analysis
    const allFlowAnalyses = [];
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`Processing chunk ${i + 1}/${chunks.length}: ${chunk.length} flows`);
        
        const chunkData = {
            metadata: flowsData.metadata,
            flows: chunk
        };
        
        const flowAnalysisPrompt = `You are a Salesforce Flow Analyst. You MUST analyze ALL ${chunk.length} flows provided in this chunk. Do not skip any flows.

For EACH AND EVERY flow provided, you must provide:
### [Exact Flow Name]
**Business Description:** 100-150 word description in simple terms a 12-year-old could understand

**Improvement Opportunities:**

**Must Have (Critical):**
- **[Bold improvement title]** - [Description] *(Estimated time: [X hours/days for experienced SF consultant])*

**Nice to Have (Optional):**
- **[Bold improvement title]** - [Description] *(Estimated time: [X hours/days for experienced SF consultant])*

CRITICAL REQUIREMENTS:
- ANALYZE ALL ${chunk.length} FLOWS - DO NOT SKIP ANY
- Use the exact flow names from the data
- Use simple language, avoid technical jargon
- Categorize improvements as "Must Have" (likely to cause bugs/issues) vs "Nice to Have" 
- Make improvement titles bold
- Include time estimates for a Salesforce consultant with 3 years experience
- Be specific about implementation (element names, when to call, etc.)
- Make recommendations actionable for Salesforce admins
- Use analogies for business descriptions

The ${chunk.length} flows you must analyze are: ${chunk.map(f => f.MasterLabel || f.FullName).join(', ')}

Flow data:
${JSON.stringify(chunkData)}`;

        console.log(`Chunk ${i + 1} data size: ${JSON.stringify(chunkData).length} characters`);

        try {
            let chunkAnalysis;
            switch (provider) {
                case 'openai':
                    chunkAnalysis = await callOpenAI(apiKey, flowAnalysisPrompt);
                    break;
                case 'claude':
                    chunkAnalysis = await callClaude(apiKey, flowAnalysisPrompt);
                    break;
                case 'mistral':
                    chunkAnalysis = await callMistral(apiKey, flowAnalysisPrompt);
                    break;
                case 'gemini':
                    chunkAnalysis = await callGemini(apiKey, flowAnalysisPrompt);
                    break;
                default:
                    throw new Error('Unsupported AI provider');
            }
            
            console.log(`Chunk ${i + 1} analysis length: ${chunkAnalysis.length} characters`);
            
            // Parse individual flows from this chunk
            const chunkResult = parseAIAnalysis(chunkAnalysis, chunkData);
            allFlowAnalyses.push(...chunkResult.flowAnalysis);
            
            // Add longer delay between chunks to avoid API overload
            if (i < chunks.length - 1) {
                console.log(`Waiting 3 seconds before next chunk...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            
        } catch (error) {
            console.error(`Error processing chunk ${i + 1}:`, error.message);
            // Add placeholder analysis for failed chunks
            for (const flow of chunk) {
                allFlowAnalyses.push({
                    name: flow.MasterLabel || flow.FullName,
                    businessDescription: 'Analysis temporarily unavailable for this flow.',
                    improvements: 'Please retry analysis or contact administrator.'
                });
            }
        }
    }
    
    // Now generate organization-level analysis using summarized data
    console.log('Generating organization-level analysis...');
    
    const orgSummary = createOrgSummaryForAnalysis(flowsData, allFlowAnalyses);
    const orgAnalysisPrompt = `You are a Salesforce Flow Analyst. Analyze the organization-wide flow architecture and provide:

## Organization Overview
Write a 100-150 word overview of the global flow architecture.

## Potential Risks & Concerns
For each risk, use this format:
**[Risk Name]** - Description of the risk and its impact.
More details about the risk.

## Organization-wide Improvements
For each improvement, use this format:
**[Improvement Name]**
    **Benefits:** List of benefits
    **Implementation Steps:**
        1. Step one
        2. Step two
        3. Step three

Requirements:
- Focus on architectural and organizational patterns
- Make risk and improvement names bold and slightly larger
- For risks: don't skip lines between items, but skip one line after each complete risk
- For improvements: move Benefits and Steps sections right (tabbed), bold the section headers
- Be specific about implementation steps
- Make recommendations actionable for Salesforce admins

Organization summary:
${JSON.stringify(orgSummary)}`;

    try {
        let orgAnalysis;
        switch (provider) {
            case 'openai':
                orgAnalysis = await callOpenAI(apiKey, orgAnalysisPrompt);
                break;
            case 'claude':
                orgAnalysis = await callClaude(apiKey, orgAnalysisPrompt);
                break;
            case 'mistral':
                orgAnalysis = await callMistral(apiKey, orgAnalysisPrompt);
                break;
            case 'gemini':
                orgAnalysis = await callGemini(apiKey, orgAnalysisPrompt);
                break;
            default:
                throw new Error('Unsupported AI provider');
        }
        
        console.log(`Organization analysis length: ${orgAnalysis.length} characters`);
        const orgResult = parseAIAnalysis(orgAnalysis, flowsData);
        
        // Combine org-level analysis with detailed flow analyses
        return {
            organizationOverview: orgResult.organizationOverview,
            potentialRisks: orgResult.potentialRisks,
            organizationImprovements: orgResult.organizationImprovements,
            flowAnalysis: allFlowAnalyses
        };
        
    } catch (error) {
        console.error('Error generating organization analysis:', error.message);
        return {
            organizationOverview: `This organization has ${flows.length} flows across various business processes. Detailed organizational analysis temporarily unavailable.`,
            potentialRisks: 'Organizational risk analysis temporarily unavailable.',
            organizationImprovements: 'Organizational improvement recommendations temporarily unavailable.',
            flowAnalysis: allFlowAnalyses
        };
    }
}

function createOrgSummaryForAnalysis(flowsData, flowAnalyses) {
    const flows = flowsData.flows;
    
    // Create a high-level summary for org analysis
    const summary = {
        metadata: {
            totalFlows: flows.length,
            orgAlias: flowsData.metadata.orgAlias,
            flowTypes: {}
        },
        patterns: {
            triggerTypes: {},
            commonElements: {},
            businessAreas: []
        },
        flowSummaries: flowAnalyses.map(analysis => ({
            name: analysis.name,
            businessSummary: analysis.businessDescription.substring(0, 100) + '...',
            keyImprovements: analysis.improvements.substring(0, 100) + '...'
        }))
    };
    
    // Analyze patterns across flows
    flows.forEach(flow => {
        // Flow types
        const type = flow.ProcessType || 'Unknown';
        summary.metadata.flowTypes[type] = (summary.metadata.flowTypes[type] || 0) + 1;
        
        // Trigger types
        if (flow.Metadata?.start?.triggerType) {
            const trigger = flow.Metadata.start.triggerType;
            summary.patterns.triggerTypes[trigger] = (summary.patterns.triggerTypes[trigger] || 0) + 1;
        }
        
        // Common elements
        if (flow.Metadata) {
            ['recordUpdates', 'recordCreates', 'decisions', 'actionCalls'].forEach(element => {
                if (flow.Metadata[element]?.length > 0) {
                    summary.patterns.commonElements[element] = (summary.patterns.commonElements[element] || 0) + 1;
                }
            });
        }
    });
    
    return summary;
}

function parseAIAnalysis(analysisText, flowsData) {
    console.log('Raw AI response length:', analysisText.length);
    console.log('Raw AI response preview:', analysisText.substring(0, 200) + '...');
    
    const result = {
        organizationOverview: '',
        potentialRisks: '',
        organizationImprovements: '',
        flowAnalysis: []
    };
    
    // Split the analysis into sections using various markdown patterns
    const sections = analysisText.split(/(?=##\s)/);
    
    for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;
        
        // Extract section headers and content more precisely
        const headerMatch = trimmed.match(/^##\s*(.+?)$/m);
        if (!headerMatch) continue;
        
        const header = headerMatch[1].toLowerCase();
        const content = trimmed.substring(headerMatch.index + headerMatch[0].length).trim();
        
        if (header.includes('organization overview') || header.includes('global flow architecture')) {
            result.organizationOverview = content;
        } else if (header.includes('potential risks') || header.includes('risk')) {
            result.potentialRisks = content;
        } else if (header.includes('organization-wide') && header.includes('improvement')) {
            result.organizationImprovements = content;
        } else if (header.includes('individual flow analysis') || header.includes('flow analysis')) {
            parseIndividualFlows(content, result, flowsData);
        }
    }
    
    // If we didn't find structured sections, try alternative parsing
    if (!result.organizationOverview && !result.potentialRisks && !result.organizationImprovements) {
        // Fallback: extract any content that looks like analysis
        const lines = analysisText.split('\n');
        let currentContent = '';
        let foundContent = false;
        
        for (const line of lines) {
            if (line.trim()) {
                currentContent += line + '\n';
                foundContent = true;
            }
        }
        
        if (foundContent) {
            // If we have content but no structure, put it all in overview
            result.organizationOverview = currentContent.trim();
        }
    }
    
    // Ensure we have individual flow analysis
    if (result.flowAnalysis.length === 0 && flowsData.flows) {
        parseIndividualFlows(analysisText, result, flowsData);
    }
    
    return result;
}

function parseIndividualFlows(content, result, flowsData) {
    console.log('Parsing individual flows from content length:', content.length);
    
    // Enhanced parsing to ensure ALL flows are captured
    let flowSections = [];
    
    // Method 1: Split by ### headers (most common format)
    let sections = content.split(/(?=###\s)/);
    if (sections.length > 1) {
        flowSections = sections;
    }
    
    // Method 2: If Method 1 didn't work, try flow-by-flow extraction using known flow names
    if (flowSections.length <= 1 && flowsData.flows) {
        console.log('Trying individual flow name extraction...');
        flowSections = [];
        
        for (const flow of flowsData.flows) {
            const flowName = flow.MasterLabel || flow.FullName;
            console.log(`Looking for flow: ${flowName}`);
            
            // Multiple patterns to catch different AI response formats
            const patterns = [
                // Standard ### header format
                new RegExp(`###\\s*${flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=###|$)`, 'i'),
                // Flow name as bold text
                new RegExp(`\\*\\*${flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*[\\s\\S]*?(?=\\*\\*Blue\\s*-|$)`, 'i'),
                // Flow name followed by colon or line break
                new RegExp(`${flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s]*[\\s\\S]*?(?=Blue\\s*-|$)`, 'i'),
                // Numbered format like "1. Flow Name"
                new RegExp(`\\d+\\.\\s*${flowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\d+\\.\\s*Blue\\s*-|$)`, 'i')
            ];
            
            for (const pattern of patterns) {
                const flowMatch = content.match(pattern);
                if (flowMatch && flowMatch[0].length > 100) { // Ensure substantial content
                    console.log(`Found ${flowName} using pattern match (length: ${flowMatch[0].length})`);
                    flowSections.push(flowMatch[0]);
                    break;
                }
            }
        }
    }
    
    // Method 3: If still no luck, try splitting by "Blue -" pattern
    if (flowSections.length <= 1) {
        console.log('Trying Blue- pattern splitting...');
        const blueSections = content.split(/(?=Blue\s*-)/);
        if (blueSections.length > 1) {
            flowSections = blueSections.slice(1); // Skip first empty section
        }
    }
    
    console.log(`Found ${flowSections.length} potential flow sections`);
    
    for (const section of flowSections) {
        const trimmed = section.trim();
        if (!trimmed || trimmed.length < 50) continue; // Increased minimum length
        
        let flowName = '';
        let flowContent = trimmed;
        
        // Extract flow name from various possible formats
        const namePatterns = [
            /^###\s*(.+?)$/m,
            /^\*\*(Blue\s*-[^*]+)\*\*/m,
            /^(Blue\s*-[^\n\r]+)/m,
            /^\d+\.\s*(Blue\s*-[^\n\r]+)/m
        ];
        
        for (const pattern of namePatterns) {
            const headerMatch = trimmed.match(pattern);
            if (headerMatch) {
                flowName = headerMatch[1].replace(/^\d+\.\s*/, '').trim();
                flowContent = trimmed.substring(headerMatch.index + headerMatch[0].length).trim();
                break;
            }
        }
        
        if (!flowName) {
            // Last resort: try to find any Blue- pattern in the section
            const blueMatch = trimmed.match(/(Blue\s*-[^\n\r]+)/);
            if (blueMatch) {
                flowName = blueMatch[1].trim();
                flowContent = trimmed;
            } else {
                console.log('Could not extract flow name from section:', trimmed.substring(0, 150));
                continue;
            }
        }
        
        console.log(`Processing flow: ${flowName}`);
        
        // Extract business description with multiple patterns
        let businessDescription = 'This flow automates business processes in your organization.';
        let improvements = 'Consider reviewing this flow for optimization opportunities.';
        
        // Enhanced business description patterns
        const businessPatterns = [
            /\*\*Business Description:\*\*\s*([\s\S]*?)(?=\*\*Improvement|###|Blue\s*-|$)/i,
            /Business Description:\s*([\s\S]*?)(?=Improvement|###|Blue\s*-|$)/i,
            /(Think of this flow[\s\S]*?)(?=\*\*Improvement|Improvement|###|Blue\s*-|$)/i,
            /(This flow[\s\S]{50,}?)(?=\*\*Improvement|Improvement|###|Blue\s*-|$)/i,
            // Capture substantial content after flow name
            /Blue\s*-[^\n\r]+\s*([\s\S]{100,}?)(?=\*\*Improvement|Improvement|###|Blue\s*-|$)/i
        ];
        
        for (const pattern of businessPatterns) {
            const match = flowContent.match(pattern);
            if (match && match[1] && match[1].trim().length > 50) {
                businessDescription = match[1].trim()
                    .replace(/^\*\*Business Description:\*\*/i, '')
                    .replace(/^Business Description:/i, '')
                    .trim();
                console.log(`Found business description for ${flowName}: ${businessDescription.substring(0, 100)}...`);
                break;
            }
        }
        
        // Enhanced improvement patterns
        const improvementPatterns = [
            /\*\*Improvement Opportunities?:\*\*\s*([\s\S]*?)(?=###|Blue\s*-|$)/i,
            /Improvement Opportunities?:\s*([\s\S]*?)(?=###|Blue\s*-|$)/i,
            /\*\*Improvements?:\*\*\s*([\s\S]*?)(?=###|Blue\s*-|$)/i,
            /((?:\d+\.\s*[\s\S]*?)*benefit[\s\S]*?)(?=###|Blue\s*-|$)/i,
            // Look for any numbered lists that might be improvements
            /((?:\d+\.\s*[^\n\r]+[\s\S]*?){1,}?)(?=###|Blue\s*-|$)/i
        ];
        
        for (const pattern of improvementPatterns) {
            const match = flowContent.match(pattern);
            if (match && match[1] && match[1].trim().length > 30) {
                improvements = match[1].trim()
                    .replace(/^\*\*Improvement Opportunities?:\*\*/i, '')
                    .replace(/^Improvement Opportunities?:/i, '')
                    .trim();
                console.log(`Found improvements for ${flowName}: ${improvements.substring(0, 100)}...`);
                break;
            }
        }
        
        result.flowAnalysis.push({
            name: flowName,
            businessDescription: businessDescription,
            improvements: improvements
        });
    }
    
    console.log(`Successfully parsed ${result.flowAnalysis.length} individual flow analyses`);
    
    // Enhanced fallback: ensure we have analysis for ALL flows in the current chunk
    if (flowsData.flows) {
        const analyzedFlowNames = result.flowAnalysis.map(f => f.name.toLowerCase());
        const missingFlows = flowsData.flows.filter(flow => {
            const flowName = (flow.MasterLabel || flow.FullName).toLowerCase();
            return !analyzedFlowNames.some(analyzed => 
                analyzed.includes(flowName) || flowName.includes(analyzed)
            );
        });
        
        if (missingFlows.length > 0) {
            console.log(`Adding fallback analysis for ${missingFlows.length} missing flows:`, missingFlows.map(f => f.MasterLabel || f.FullName));
            for (const flow of missingFlows) {
                result.flowAnalysis.push({
                    name: flow.MasterLabel || flow.FullName,
                    businessDescription: `This flow automates business processes in your organization. The ${flow.ProcessType} runs when specific conditions are met and helps maintain data consistency and business rules.`,
                    improvements: 'Consider adding error handling, implementing bulk processing for better performance, and documenting the business logic for easier maintenance.'
                });
            }
        }
    }
}


// Helper function to get flows data
async function getFlowsData() {
    const conn = new jsforce.Connection({
        instanceUrl: connectionInfo.instanceUrl,
        accessToken: connectionInfo.accessToken
    });

    // Get detailed metadata for each flow using Tooling API (following extract_flows.sh logic)
    const flowDetails = [];
    
    // First, get all active Flow IDs using the basic query (like the script does)
    console.log("📋 Getting basic flow information...");
    const basicFlowQuery = `
        SELECT Id, MasterLabel, Status, ProcessType, TriggerOrder, LastModifiedDate, Description 
        FROM Flow 
        WHERE Status = 'Active'
    `;
    
    const basicFlowsResult = await conn.tooling.query(basicFlowQuery);
    const basicFlows = basicFlowsResult.records || [];
    
    console.log(`📊 Found ${basicFlows.length} active flows to process`);
    
    // Now get detailed metadata for each flow using ID (like extract_flows.sh does)
    for (let i = 0; i < basicFlows.length; i++) {
        const basicFlow = basicFlows[i];
        try {
            console.log(`⏳ [${i + 1}/${basicFlows.length}] Processing flow: ${basicFlow.MasterLabel || basicFlow.Id}`);
            
            // Use direct REST API call to get complete metadata (like CLI does)
            const detailedFlowQuery = `SELECT Id, FullName, MasterLabel, Status, ProcessType, Metadata, TriggerOrder, ApiVersion, LastModifiedDate, Description FROM Flow WHERE Id = '${basicFlow.Id}'`;
            
            const apiUrl = `${connectionInfo.instanceUrl}/services/data/v64.0/tooling/query/?q=${encodeURIComponent(detailedFlowQuery)}`;
            
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${connectionInfo.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const detailedFlowResult = await response.json();
            
            if (detailedFlowResult.records && detailedFlowResult.records.length > 0) {
                const flowRecord = detailedFlowResult.records[0];
                console.log(`   ✅ Success - ProcessType: ${flowRecord.ProcessType}, ApiVersion: ${flowRecord.ApiVersion}`);
                
                // Extract complete flow record with all metadata preserved (exactly like CLI script)
                const completeFlowRecord = {
                    attributes: {
                        type: "Flow",
                        url: `/services/data/v64.0/tooling/sobjects/Flow/${flowRecord.Id}`
                    },
                    Id: flowRecord.Id,
                    FullName: flowRecord.FullName,
                    MasterLabel: flowRecord.MasterLabel,
                    Status: flowRecord.Status,
                    ProcessType: flowRecord.ProcessType,
                    Metadata: flowRecord.Metadata,
                    TriggerOrder: flowRecord.TriggerOrder,
                    ApiVersion: flowRecord.ApiVersion,
                    LastModifiedDate: flowRecord.LastModifiedDate,
                    Description: flowRecord.Description
                };
                
                flowDetails.push(completeFlowRecord);
            } else {
                console.log(`   ❌ Failed to get detailed metadata`);
                // Add basic info with error
                flowDetails.push({
                    attributes: {
                        type: "Flow",
                        url: `/services/data/v64.0/tooling/sobjects/Flow/${basicFlow.Id}`
                    },
                    Id: basicFlow.Id,
                    FullName: 'Unknown',
                    MasterLabel: basicFlow.MasterLabel,
                    Status: basicFlow.Status,
                    ProcessType: basicFlow.ProcessType,
                    TriggerOrder: basicFlow.TriggerOrder,
                    ApiVersion: null,
                    LastModifiedDate: basicFlow.LastModifiedDate,
                    Description: basicFlow.Description,
                    Metadata: {},
                    error: 'Could not fetch detailed metadata'
                });
            }
            
            // Pause to avoid API limits (like the script does)
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (flowError) {
            console.error(`   ❌ Error processing flow ${basicFlow.Id}:`, flowError.message);
            flowDetails.push({
                attributes: {
                    type: "Flow",
                    url: `/services/data/v64.0/tooling/sobjects/Flow/${basicFlow.Id}`
                },
                Id: basicFlow.Id,
                FullName: 'Unknown',
                MasterLabel: basicFlow.MasterLabel,
                Status: basicFlow.Status,
                ProcessType: basicFlow.ProcessType,
                TriggerOrder: basicFlow.TriggerOrder,
                ApiVersion: null,
                LastModifiedDate: basicFlow.LastModifiedDate,
                Description: basicFlow.Description,
                Metadata: {},
                error: flowError.message
            });
        }
    }

    return {
        metadata: {
            retrievedAt: new Date().toISOString(),
            orgAlias: connectionInfo.instanceUrl.replace('https://', '').split('.')[0],
            orgUsername: connectionInfo.userInfo.username || 'Unknown',
            totalFlows: flowDetails.length,
            source: "Salesforce Flow Analyzer Tool"
        },
        flows: flowDetails
    };
}

// OAuth Configuration
const oauth2 = new jsforce.OAuth2({
    loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
    clientId: process.env.SALESFORCE_CLIENT_ID,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    redirectUri: process.env.SALESFORCE_REDIRECT_URI || 'http://localhost:3000/auth/callback'
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: require('./package.json').version,
        authenticated: !!connectionInfo.accessToken
    });
});

// Store credentials and start OAuth flow
app.post('/auth/set-credentials', (req, res) => {
    const { clientId, clientSecret } = req.body;
    
    if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Client ID and Secret are required' });
    }
    
    // Generate a session ID and store credentials temporarily
    const sessionId = Date.now().toString();
    tempCredentials[sessionId] = {
        clientId,
        clientSecret,
        timestamp: Date.now()
    };
    
    // Clean up old credentials (older than 10 minutes)
    Object.keys(tempCredentials).forEach(id => {
        if (Date.now() - tempCredentials[id].timestamp > 10 * 60 * 1000) {
            delete tempCredentials[id];
        }
    });
    
    res.json({ sessionId });
});

// Start OAuth flow
app.get('/auth/salesforce', (req, res) => {
    const sessionId = req.query.sessionId;
    const isSandbox = req.query.isSandbox === 'true';
    
    // Use provided credentials or fall back to env
    let clientId, clientSecret;
    
    if (sessionId && tempCredentials[sessionId]) {
        clientId = tempCredentials[sessionId].clientId;
        clientSecret = tempCredentials[sessionId].clientSecret;
        console.log('Using dynamic credentials for OAuth flow');
    } else {
        clientId = process.env.SALESFORCE_CLIENT_ID;
        clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
        console.log('Using environment credentials for OAuth flow');
    }
    
    if (!clientId || !clientSecret) {
        return res.status(400).send('No credentials available. Please provide Connected App credentials.');
    }
    
    // Determine login URL based on environment type
    const sfLoginUrl = isSandbox ? 
        (process.env.SALESFORCE_SANDBOX_URL || 'https://test.salesforce.com') : 
        (process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com');
    console.log(`Using login URL: ${sfLoginUrl} (sandbox: ${isSandbox})`);
    
    // Create OAuth2 client with dynamic credentials and environment-specific URL
    const dynamicOAuth2 = new jsforce.OAuth2({
        loginUrl: sfLoginUrl,
        clientId: clientId,
        clientSecret: clientSecret,
        redirectUri: process.env.SALESFORCE_REDIRECT_URI || 'http://localhost:3000/auth/callback'
    });
    
    const authUrl = dynamicOAuth2.getAuthorizationUrl({
        scope: 'api refresh_token',
        state: sessionId ? `salesforce-flow-analyzer-${sessionId}` : 'salesforce-flow-analyzer'
    });
    
    res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    
    // Handle OAuth errors
    if (error) {
        console.error('OAuth Error:', error, error_description);
        let errorMessage = 'Authentication failed';
        
        if (error === 'OAUTH_AUTHORIZATION_BLOCKED') {
            errorMessage = `
                <h2>Organization Configuration Required</h2>
                <p><strong>Error:</strong> ${error_description}</p>
                <p>This means you need to create a Connected App in the target Salesforce organization.</p>
                <h3>Steps to fix:</h3>
                <ol>
                    <li>Log into the Salesforce org you want to analyze</li>
                    <li>Go to Setup → App Manager → New Connected App</li>
                    <li>Configure with these settings:
                        <ul>
                            <li><strong>Callback URL:</strong> http://localhost:3000/auth/callback</li>
                            <li><strong>Selected OAuth Scopes:</strong> Full access (full), Refresh token</li>
                        </ul>
                    </li>
                    <li>Copy the Consumer Key and Secret</li>
                    <li>Update your .env file with the new credentials</li>
                </ol>
                <p><a href="/">← Back to Login</a></p>
            `;
        }
        
        return res.status(400).send(errorMessage);
    }
    
    if (!code) {
        return res.status(400).send('Authorization code not found');
    }

    try {
        // Extract session ID from state if present
        const sessionId = state?.replace('salesforce-flow-analyzer-', '');
        
        let oauth2ToUse;
        if (sessionId && tempCredentials[sessionId]) {
            // Use dynamic credentials
            oauth2ToUse = new jsforce.OAuth2({
                loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
                clientId: tempCredentials[sessionId].clientId,
                clientSecret: tempCredentials[sessionId].clientSecret,
                redirectUri: process.env.SALESFORCE_REDIRECT_URI || 'http://localhost:3000/auth/callback'
            });
            console.log('Using dynamic credentials for callback');
        } else {
            // Use environment credentials
            oauth2ToUse = oauth2;
            console.log('Using environment credentials for callback');
        }
        
        const conn = new jsforce.Connection({ oauth2: oauth2ToUse });
        const userInfo = await conn.authorize(code);
        
        // Store connection info
        connectionInfo = {
            accessToken: conn.accessToken,
            refreshToken: conn.refreshToken,
            instanceUrl: conn.instanceUrl,
            userInfo: userInfo
        };

        // Clean up temporary credentials
        if (sessionId && tempCredentials[sessionId]) {
            delete tempCredentials[sessionId];
        }

        console.log(`Successfully connected to org: ${userInfo.organizationName || userInfo.organization_name || 'Unknown'}`);
        console.log('User info:', userInfo);
        res.redirect('/dashboard');
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send('Authentication failed: ' + error.message);
    }
});

// Dashboard page
app.get('/dashboard', (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API endpoint to fetch flow metadata
app.get('/api/flows', async (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const flowsData = await getFlowsData();
        res.json(flowsData);
    } catch (error) {
        console.error('Error fetching flows:', error);
        res.status(500).json({ error: 'Failed to fetch flows: ' + error.message });
    }
});

// Get Salesforce instance URL for flow links
app.get('/api/instance', (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    if (connectionInfo.instanceUrl) {
        res.json({ instanceUrl: connectionInfo.instanceUrl });
    } else {
        res.status(404).json({ error: 'No active Salesforce connection' });
    }
});

// Get org info for display
app.get('/api/org-info', (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const userInfo = connectionInfo.userInfo;
    let orgName = 'Unknown Org';
    
    // Try different ways to get org name
    if (userInfo?.organizationName) {
        orgName = userInfo.organizationName;
    } else if (userInfo?.organization_name) {
        orgName = userInfo.organization_name;
    } else if (connectionInfo.instanceUrl) {
        // Extract org domain from instance URL
        const match = connectionInfo.instanceUrl.match(/https:\/\/([^.]+)/);
        if (match) {
            orgName = match[1] + '.lightning.force.com';
        }
    }
    
    res.json({
        orgName: orgName,
        username: userInfo?.email || userInfo?.username || 'Unknown User',
        instanceUrl: connectionInfo.instanceUrl
    });
});

// API endpoint to export flows as JSON
app.get('/api/flows/export', async (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const flowsData = await getFlowsData();
        const fileName = `all-flows-detailed-${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.json(flowsData);

    } catch (error) {
        console.error('Error exporting flows:', error);
        res.status(500).json({ error: 'Failed to export flows: ' + error.message });
    }
});


// AI Analysis endpoint
app.post('/api/flows/ai-analysis', async (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { provider, apiKey, flowsData } = req.body;
    
    if (!provider || !apiKey || !flowsData) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        console.log(`Starting AI analysis with provider: ${provider}`);
        const analysisResult = await performAIAnalysis(provider, apiKey, flowsData);
        
        // Store context for follow-up questions
        aiContext.provider = provider;
        aiContext.apiKey = apiKey;
        aiContext.flowsData = flowsData;
        aiContext.analysisResult = analysisResult;
        
        console.log('AI analysis completed successfully');
        res.json(analysisResult);
        
    } catch (error) {
        console.error('AI Analysis error:', error);
        console.error('Error response data:', error.response?.data);
        
        // Provide more specific error messages
        let errorMessage = 'Failed to perform AI analysis';
        let statusCode = 500;
        
        if (error.response?.status === 401) {
            console.log('API 401 error details:', JSON.stringify(error.response?.data, null, 2));
            errorMessage = 'Invalid API key. Please check your API key and try again.';
            statusCode = 401;
        } else if (error.response?.status === 403) {
            errorMessage = 'API key does not have sufficient permissions.';
            statusCode = 403;
        } else if (error.response?.status === 429) {
            errorMessage = 'Rate limit exceeded. Please try again later.';
            statusCode = 429;
        } else if (error.response?.status === 400) {
            console.log('Claude API 400 error details:', JSON.stringify(error.response?.data, null, 2));
            errorMessage = `Bad request: ${error.response?.data?.error?.message || error.response?.data?.message || 'The data might be too large or malformed'}.`;
            statusCode = 400;
            
            // For Claude 400 errors, suggest trying a different provider
            if (provider === 'claude') {
                console.log('Claude failed with 400 error. User should try a different provider.');
                errorMessage = 'Claude API rejected the request. Please try using OpenAI, Mistral, or Gemini instead.';
            }
        } else if (error.response?.status === 529) {
            console.log('API 529 overloaded error details:', JSON.stringify(error.response?.data, null, 2));
            errorMessage = 'AI service is temporarily overloaded. Please wait a moment and try again.';
            statusCode = 529;
        } else if (error.response?.status === 520) {
            console.log('API 520 error details:', JSON.stringify(error.response?.data, null, 2));
            errorMessage = 'Server connection error. This may be due to a large dataset or network timeout. Try analyzing smaller groups of flows.';
            statusCode = 520;
        } else if (error.response?.status === 502) {
            console.log('API 502 error details:', JSON.stringify(error.response?.data, null, 2));
            errorMessage = 'Service temporarily unavailable. This may be a Render infrastructure issue. Please try again in a few minutes.';
            statusCode = 502;
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            details: error.response?.data || error.message,
            provider: provider,
            statusCode: error.response?.status || 500
        });
    }
});

// Chat endpoint for follow-up questions
app.post('/api/flows/chat', async (req, res) => {
    if (!connectionInfo.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { question } = req.body;
    
    if (!question || !aiContext.provider || !aiContext.apiKey) {
        return res.status(400).json({ error: 'Missing chat context or question' });
    }

    try {
        // Create a lightweight summary for chat context instead of sending full flow data
        const flowSummary = {
            totalFlows: aiContext.flowsData?.metadata?.totalFlows || 0,
            orgAlias: aiContext.flowsData?.metadata?.orgAlias || 'Unknown',
            flowNames: aiContext.flowsData?.flows?.map(f => f.MasterLabel || f.FullName) || [],
            flowTypes: aiContext.flowsData?.flows?.reduce((acc, f) => {
                const type = f.ProcessType || 'Unknown';
                acc[type] = (acc[type] || 0) + 1;
                return acc;
            }, {}) || {}
        };

        const chatPrompt = `Based on our previous analysis of the Salesforce flows, please answer this follow-up question:

Question: ${question}

Context from previous analysis:
- Organization: ${flowSummary.orgAlias}
- Total flows: ${flowSummary.totalFlows}
- Flow types: ${JSON.stringify(flowSummary.flowTypes)}
- Flow names: ${flowSummary.flowNames.join(', ')}

Previous analysis results:
${JSON.stringify(aiContext.analysisResult, null, 2)}

Please provide a detailed, helpful answer based on the flow analysis context above.`;

        let response;
        switch (aiContext.provider) {
            case 'openai':
                response = await callOpenAI(aiContext.apiKey, chatPrompt);
                break;
            case 'claude':
                response = await callClaude(aiContext.apiKey, chatPrompt);
                break;
            case 'mistral':
                response = await callMistral(aiContext.apiKey, chatPrompt);
                break;
            case 'gemini':
                response = await callGemini(aiContext.apiKey, chatPrompt);
                break;
            default:
                throw new Error('Unsupported AI provider');
        }

        res.json({ response });
        
    } catch (error) {
        console.error('Chat error:', error);
        
        // Handle specific API overload errors
        if (error.response?.status === 529) {
            res.status(503).json({ 
                error: 'AI service is temporarily overloaded. Please try again in a few minutes.',
                statusCode: 529,
                retryAfter: 30
            });
        } else if (error.response?.status === 400) {
            res.status(400).json({ 
                error: 'Invalid request. Please try rephrasing your question.',
                statusCode: 400
            });
        } else {
            res.status(500).json({ 
                error: 'Failed to process question: ' + error.message,
                statusCode: error.response?.status || 500
            });
        }
    }
});

// Logout
app.post('/auth/logout', (req, res) => {
    // Clear all stored connection and AI data
    connectionInfo = {};
    aiContext = {
        provider: null,
        apiKey: null,
        flowsData: null,
        analysisResult: null
    };
    
    console.log('User logged out, session cleared');
    res.json({ success: true, message: 'Logged out successfully' });
});



// Start server
app.listen(PORT, () => {
    console.log(`Salesforce Flow Analyzer running on http://localhost:${PORT}`);
    console.log('Make sure to set up your Salesforce Connected App and update the .env file');
});

module.exports = app;