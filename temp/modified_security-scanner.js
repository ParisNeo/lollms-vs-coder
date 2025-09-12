#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

class NodeModulesScanners {
    constructor() {
        // Critical malware patterns
        this.suspiciousPatterns = [
            { pattern: /window\.ethereum/gi, threshold: 0, severity: 'CRITICAL' },
            { pattern: /eth_accounts|eth_sendTransaction/gi, threshold: 0, severity: 'CRITICAL' },
            { pattern: /checkethereumw|runmask|newdlocal/gi, threshold: 0, severity: 'CRITICAL' },
            { pattern: /XMLHttpRequest\.prototype\./gi, threshold: 0, severity: 'CRITICAL' },
            { pattern: /window\.stealthProxyControl/gi, threshold: 0, severity: 'CRITICAL' },
            { pattern: /zprkq|iJAYR|nqxhl|myaXd/g, threshold: 0, severity: 'CRITICAL' },
            { pattern: /0xFc4a4858bafef54D1b1d7697bfb5c52F4c166976/g, threshold: 0, severity: 'CRITICAL' },
            { pattern: /1H13VnQJKtT4HjD5ZFKaaiZEetMbG7nDHx/g, threshold: 0, severity: 'CRITICAL' }
        ];

        this.findings = [];
        this.hexVarStats = [];
        this.scanStats = {
            totalFiles: 0,
            scannedFiles: 0,
            startTime: new Date(),
            errors: []
        };
    }

    async scanDirectory(dirPath = './node_modules') {
        console.log(`🔍 Starting security scan of: ${dirPath}`);
        
        if (!fs.existsSync(dirPath)) {
            console.log('❌ Directory not found');
            return;
        }

        await this.walkDirectory(dirPath);
        this.analyzeHexVariables();
        this.generateReport();
        this.exportDetailedJSON();
    }

    async walkDirectory(dirPath) {
        const items = fs.readdirSync(dirPath);
        
        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                await this.walkDirectory(fullPath);
            } else if (this.shouldScanFile(fullPath)) {
                this.scanStats.totalFiles++;
                await this.scanFile(fullPath);
            }
        }
    }

    shouldScanFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const skipFiles = ['package-lock.json', '.package-lock.json'];
        
        if (skipFiles.some(skip => filePath.includes(skip))) {
            return false;
        }
        
        return ['.js', '.ts', '.json'].includes(ext);
    }

    async scanFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            this.scanStats.scannedFiles++;
            
            // Count _0x variables
            this.countHexVariables(filePath, content);
            
            // Scan for critical patterns
            this.scanCriticalPatterns(filePath, content);
            
            if (path.basename(filePath) === 'package.json') {
                this.scanPackageJson(filePath, content);
            }
        } catch (error) {
            this.scanStats.errors.push({
                file: filePath,
                error: error.message
            });
        }
    }

    countHexVariables(filePath, content) {
        const hexMatches = content.match(/_0x[a-f0-9]{3,6}/gi) || [];
        
        if (hexMatches.length > 0) {
            const isInDist = filePath.includes(path.sep + 'dist' + path.sep) || 
                             filePath.includes(path.sep + 'build' + path.sep) ||
                             filePath.includes(path.sep + 'assets' + path.sep);
            const isInNodeModules = filePath.includes(path.sep + 'node_modules' + path.sep);
            const packageName = this.extractPackageName(filePath);
            
            const stat = {
                filePath,
                count: hexMatches.length,
                location: isInDist ? 'dist' : isInNodeModules ? 'node_modules' : 'source',
                packageName,
                fileSize: content.length,
                isMinified: this.isMinified(content)
            };
            
            this.hexVarStats.push(stat);
        }
    }

    scanCriticalPatterns(filePath, content) {
        this.suspiciousPatterns.forEach(patternObj => {
            const matches = content.match(patternObj.pattern) || [];
            if (matches.length > 0) {
                this.addFinding(
                    patternObj.severity,
                    `🚨 MALWARE SIGNATURE: ${patternObj.pattern.source}`,
                    filePath,
                    matches[0]
                );
            }
        });
    }

    scanPackageJson(filePath, content) {
        try {
            const packageData = JSON.parse(content);
            
            if (packageData.scripts) {
                Object.entries(packageData.scripts).forEach(([scriptName, scriptContent]) => {
                    if (typeof scriptContent === 'string') {
                        const criticalCommands = [
                            /curl\s+.*\|\s*bash/gi,
                            /wget\s+.*\|\s*sh/gi,
                            /eval.*\(.*base64/gi,
                            /checkethereumw|runmask|newdlocal/gi
                        ];
                        criticalCommands.forEach(pattern => {
                            if (pattern.test(scriptContent)) {
                                this.addFinding(
                                    'CRITICAL',
                                    `🚨 MALICIOUS npm script: ${scriptName}`,
                                    filePath,
                                    scriptContent
                                );
                            }
                        });
                    }
                });
            }
        } catch (error) {
            // Skip invalid JSON
        }
    }

    analyzeHexVariables() {
        if (this.hexVarStats.length === 0) return;

        console.log('\n📊 _0x VARIABLE ANALYSIS');
        console.log('='.repeat(60));

        // Group by location
        const byLocation = this.hexVarStats.reduce((groups, stat) => {
            if (!groups[stat.location]) groups[stat.location] = [];
            groups[stat.location].push(stat);
            return groups;
        }, {});

        // Analyze each location
        Object.entries(byLocation).forEach(([location, stats]) => {
            const locationEmoji = location === 'dist' ? '📦' : location === 'node_modules' ? '🔧' : '📝';
            console.log(`\n${locationEmoji} ${location.toUpperCase()} files:`);
            
            // Sort by count descending
            stats.sort((a, b) => b.count - a.count);
            
            stats.forEach(stat => {
                const severity = this.classifyHexVariables(stat);
                const icon = severity === 'CRITICAL' ? '🚨' : severity === 'WARNING' ? '⚠️' : 'ℹ️';
                
                console.log(`${icon} ${severity}: ${stat.count} _0x variables`);
                console.log(`   📄 ${path.basename(stat.filePath)}`);
                console.log(`   📦 Package: ${stat.packageName}`);
                console.log(`   💾 Size: ${Math.round(stat.fileSize/1024)}KB | Minified: ${stat.isMinified ? '✅' : '❌'}`);
                
                if (severity === 'CRITICAL') {
                    this.addFinding(
                        'CRITICAL',
                        `🚨 Excessive _0x variables: ${stat.count} occurrences`,
                        stat.filePath,
                        `Found ${stat.count} instances`
                    );
                }
            });
        });

        this.buildDynamicThresholds();
    }

    buildDynamicThresholds() {
        console.log('\n🎯 LOCATION-SPECIFIC THRESHOLDS:');
        console.log('   📦 DIST/BUILD: 0-50 normal, 51-100 warning, 100+ critical');
        console.log('   🔧 NODE_MODULES: 0-3 normal, 4-8 warning, 9+ CRITICAL');  
        console.log('   📝 SOURCE CODE: 0-1 normal, 2-3 warning, 4+ CRITICAL');
        console.log('\n💡 RATIONALE:');
        console.log('   📦 Dist files SHOULD have many _0x (minification)');
        console.log('   🔧 Node modules should have FEW _0x (source packages)');
        console.log('   📝 Your source code should have ZERO _0x (you wrote it)');
    }

    classifyHexVariables(stat) {
        if (stat.location === 'dist') {
            if (stat.count <= 50) return 'INFO';
            if (stat.count <= 100) return 'WARNING';
            return 'CRITICAL';
        } else if (stat.location === 'node_modules') {
            if (stat.count <= 3) return 'INFO';
            if (stat.count <= 8) return 'WARNING';
            return 'CRITICAL';
        } else { // source
            if (stat.count <= 1) return 'INFO';
            if (stat.count <= 3) return 'WARNING';
            return 'CRITICAL';
        }
    }

    isMinified(content) {
        const lines = content.split('\n');
        const avgLineLength = content.length / lines.length;
        return (
            avgLineLength > 300 ||
            content.includes('/*! ') ||
            (lines.length < 10 && content.length > 1000)
        );
    }

    extractPackageName(filePath) {
        // const parts = filePath.split(path.sep);
        // const nodeModulesIndex = parts.findIndex(part => part === 'node_modules');
        // return nodeModulesIndex !== -1 && parts[nodeModulesIndex + 1]
        //     ? parts[nodeModulesIndex + 1]
        //     : 'unknown';
    }

    addFinding(severity, message, filePath, context) {
        this.findings.push({
            severity,
            message,
            filePath,
            context,
            timestamp: new Date().toISOString(),
            packageName: this.extractPackageName(filePath)
        });
    }

    generateReport() {
        console.log('\n' + '='.repeat(60));
        console.log('🛡️  SECURITY SCAN REPORT');
        console.log('='.repeat(60));
        
        if (this.findings.length === 0) {
            console.log('✅ No malware signatures detected');
            console.log('✅ Your project appears to be CLEAN');
            
            if (this.hexVarStats.length > 0) {
                const totalHexVars = this.hexVarStats.reduce((sum, stat) => sum + stat.count, 0);
                console.log(`\nℹ️  Found ${totalHexVars} _0x variables across ${this.hexVarStats.length} files (all within normal ranges)`);
            }
        } else {
            const groupedFindings = this.groupFindingsBySeverity();
            
            ['CRITICAL', 'WARNING', 'ERROR'].forEach(severity => {
                if (groupedFindings[severity] && groupedFindings[severity].length > 0) {
                    const icon = severity === 'CRITICAL' ? '🚨' : severity === 'WARNING' ? '⚠️' : '❌';
                    console.log(`\n${icon} ${severity} Issues (${groupedFindings[severity].length}):`);
                    console.log('-'.repeat(40));
                    
                    groupedFindings[severity].forEach((finding, index) => {
                        console.log(`${index + 1}. ${finding.message}`);
                        console.log(`   📁 File: ${finding.filePath}`);
                        console.log(`   📦 Package: ${finding.packageName}`);
                        if (finding.context) {
                            console.log(`   🔍 Context: ${finding.context.substring(0, 100)}...`);
                        }
                        console.log('');
                    });
                }
            });

            console.log('\n' + '='.repeat(60));
            console.log('📊 SUMMARY');
            console.log('='.repeat(60));
            console.log(`Total findings: ${this.findings.length}`);
            console.log(`Critical: ${groupedFindings.CRITICAL?.length || 0}`);
            console.log(`Warnings: ${groupedFindings.WARNING?.length || 0}`);
        }
    }

    exportDetailedJSON() {
        const endTime = new Date();
        
        const detailedReport = {
            scanMetadata: {
                scanDate: endTime.toISOString(),
                duration: endTime - this.scanStats.startTime,
                totalFiles: this.scanStats.totalFiles,
                scannedFiles: this.scanStats.scannedFiles,
                errors: this.scanStats.errors.length,
                tool: "npm-security-scanner v1.0 🛡️",
                author: "ParisNeo 👨‍💻",
                purpose: "Detect npm supply chain attacks and malware 🔍"
            },
            findings: {
                total: this.findings.length,
                critical: this.findings.filter(f => f.severity === 'CRITICAL').length,
                warnings: this.findings.filter(f => f.severity === 'WARNING').length,
                errors: this.findings.filter(f => f.severity === 'ERROR').length,
                details: this.findings
            },
            hexVariableAnalysis: {
                totalFilesWithHexVars: this.hexVarStats.length,
                totalHexVariables: this.hexVarStats.reduce((sum, stat) => sum + stat.count, 0),
                byLocation: this.groupHexVarsByLocation(),
                details: this.hexVarStats.map(stat => ({
                    ...stat,
                    severity: this.classifyHexVariables(stat)
                }))
            },
            recommendations: this.generateRecommendations(),
            llmAnalysisPrompt: this.generateLLMPrompt()
        };

        const fileName = `security-scan-${new Date().toISOString().split('T')[0]}.json`;
        fs.writeFileSync(fileName, JSON.stringify(detailedReport, null, 2));
        
        console.log(`\n📄 Detailed JSON report exported: ${fileName}`);
        console.log('\n🤖 You can now:');
        console.log('1. 🔍 Analyze this JSON file manually');
        console.log('2. 🧠 Feed it to an LLM like Lollms for advanced analysis');
        console.log('3. 📋 Use it for compliance reporting');
        console.log('4. 📈 Track changes over time');
        
        return fileName;
    }

    groupHexVarsByLocation() {
        const grouped = this.hexVarStats.reduce((groups, stat) => {
            if (!groups[stat.location]) {
                groups[stat.location] = {
                    count: 0,
                    files: 0,
                    averagePerFile: 0,
                    maxInSingleFile: 0,
                    emoji: stat.location === 'dist' ? '📦' : stat.location === 'node_modules' ? '🔧' : '📝'
                };
            }
            
            groups[stat.location].count += stat.count;
            groups[stat.location].files += 1;
            groups[stat.location].maxInSingleFile = Math.max(groups[stat.location].maxInSingleFile, stat.count);
            
            return groups;
        }, {});

        // Calculate averages
        Object.values(grouped).forEach(group => {
            group.averagePerFile = Math.round(group.count / group.files * 100) / 100;
        });

        return grouped;
    }

    generateRecommendations() {
        const recommendations = [];

        if (this.findings.filter(f => f.severity === 'CRITICAL').length > 0) {
            recommendations.push({
                priority: 'URGENT',
                emoji: '🚨',
                action: 'CRITICAL malware signatures detected. Stop using this project immediately.',
                details: 'Your project contains known malware patterns from supply chain attacks.'
            });
        }

        if (this.hexVarStats.some(s => s.location === 'node_modules' && s.count > 8)) {
            recommendations.push({
                priority: 'HIGH',
                emoji: '⚠️',
                action: 'Suspicious obfuscation detected in node_modules',
                details: 'Some packages contain unexpectedly high levels of code obfuscation.'
            });
        }

        if (this.hexVarStats.some(s => s.location === 'source' && s.count > 3)) {
            recommendations.push({
                priority: 'HIGH',
                emoji: '🔍',
                action: 'Obfuscated code detected in your source files',
                details: 'Your own source code contains obfuscation patterns - investigate immediately.'
            });
        }

        if (recommendations.length === 0) {
            recommendations.push({
                priority: 'INFO',
                emoji: '✅',
                action: 'Project appears clean',
                details: 'No malware signatures or suspicious patterns detected.'
            });
        }

        return recommendations;
    }

    generateLLMPrompt() {
        return {
            prompt: `🤖 You are a cybersecurity expert analyzing the results of an npm security scan. 
            
Please analyze this security scan report and provide insights on:

1. 🎯 Risk Assessment: What is the overall security risk level of this project?
2. 🔍 Threat Analysis: Are there any patterns that suggest supply chain attacks?
3. ✅ False Positives: Are any findings likely to be legitimate code patterns?
4. 💡 Recommendations: What specific actions should the developer take?
5. 📊 Context Analysis: How do the _0x variable counts compare to normal expectations?

Focus on practical, actionable advice. Consider that this scan was built in response to the September 2025 npm supply chain attack that compromised 18 packages with 2.6 billion weekly downloads.`,
            
            instructions: "📋 Copy the entire JSON report above and paste it after this prompt when asking your LLM (like Lollms) for analysis.",
            
            example: "🧠 Hey Lollms, please analyze this npm security scan report: [PASTE_FULL_JSON_HERE]"
        };
    }

    groupFindingsBySeverity() {
        return this.findings.reduce((groups, finding) => {
            if (!groups[finding.severity]) {
                groups[finding.severity] = [];
            }
            groups[finding.severity].push(finding);
            return groups;
        }, {});
    }
}

// Command line argument support
const scanPath = process.argv[2] || './node_modules';

(async () => {
    const scanner = new NodeModulesScanners();
    await scanner.scanDirectory(scanPath);
})();
