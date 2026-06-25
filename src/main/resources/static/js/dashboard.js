document.addEventListener('DOMContentLoaded', () => {
    // Track active build/deploy jobs and countdown timers per project
    const activePolls = {};
    const countdownIntervals = {};
    const activeJobs = {};
    const jobDetailsCache = {};

    // Modal elements and closing listeners
    const modal = document.getElementById('info-modal');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    if (modalCloseBtn) {
        modalCloseBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    // 1. Dynamic Branch Loading (Run on Pipeline page)
    const cards = document.querySelectorAll('.project-card');
    cards.forEach(async (card) => {
        const projectId = card.dataset.projectId;
        const buildConfig = card.dataset.buildConfig;
        const deployConfig = card.dataset.deployConfig;
        
        const branchSelect = card.querySelector('.branch-selector');
        const envSelect = card.querySelector('.env-selector');
        
        const buildBtn = card.querySelector('.trigger-build-btn');
        const deployBtn = card.querySelector('.trigger-deploy-btn');
        
        const cancelBuildBtn = card.querySelector('.cancel-build-btn');
        const cancelDeployBtn = card.querySelector('.cancel-deploy-btn');
        
        const infoBuildBtn = card.querySelector('.info-build-btn');
        const infoDeployBtn = card.querySelector('.info-deploy-btn');
        
        // Fetch and load branches dynamically
        await loadBranches(projectId, branchSelect, buildConfig);

        // Branch change listener -> check status of selected branch
        branchSelect.addEventListener('change', () => {
            if (branchSelect.value) {
                showToast(`Checking branch status: ${branchSelect.value}`, 'info');
                checkLatestBuildStatus(projectId, buildConfig, branchSelect.value);
                loadLastSuccessfulBuilds(projectId, buildConfig, branchSelect.value);
            }
        });

        // Trigger Build button
        buildBtn.addEventListener('click', () => {
            const branch = branchSelect.value;
            triggerBuild(projectId, buildConfig, branch);
        });

        // Trigger Deploy button
        deployBtn.addEventListener('click', () => {
            const branch = branchSelect.value;
            const env = envSelect.value;
            const versionSelect = card.querySelector('.build-version-selector');
            const buildNumber = versionSelect ? versionSelect.value : null;
            triggerDeploy(projectId, deployConfig, branch, env, buildNumber);
        });

        // Cancel buttons
        if (cancelBuildBtn) {
            cancelBuildBtn.addEventListener('click', () => {
                const buildId = activeJobs[`${projectId}-build`];
                if (buildId) cancelJob(projectId, buildId, 'build');
            });
        }

        if (cancelDeployBtn) {
            cancelDeployBtn.addEventListener('click', () => {
                const buildId = activeJobs[`${projectId}-deploy`];
                if (buildId) cancelJob(projectId, buildId, 'deploy');
            });
        }

        // Info details buttons
        if (infoBuildBtn) {
            infoBuildBtn.addEventListener('click', () => {
                showJobDetails(`${projectId}-build`);
            });
        }

        if (infoDeployBtn) {
            infoDeployBtn.addEventListener('click', () => {
                showJobDetails(`${projectId}-deploy`);
            });
        }
    });

    // Fetch branches from backend API and render
    async function loadBranches(projectId, selectEl, buildConfig) {
        try {
            const response = await fetch(`/api/projects/${projectId}/branches`);
            if (response.ok) {
                const branches = await response.json();
                selectEl.innerHTML = ''; // clear loading option
                
                if (branches && branches.length > 0) {
                    branches.forEach(branch => {
                        const opt = document.createElement('option');
                        opt.value = branch;
                        opt.innerText = branch;
                        selectEl.appendChild(opt);
                    });
                    
                    // Trigger initial build check for first branch
                    checkLatestBuildStatus(projectId, buildConfig, selectEl.value);
                    loadLastSuccessfulBuilds(projectId, buildConfig, selectEl.value);
                } else {
                    const opt = document.createElement('option');
                    opt.value = 'main';
                    opt.innerText = 'main (default)';
                    selectEl.appendChild(opt);
                    checkLatestBuildStatus(projectId, buildConfig, 'main');
                    loadLastSuccessfulBuilds(projectId, buildConfig, 'main');
                }
            } else {
                throw new Error('Failed to load branches');
            }
        } catch (error) {
            console.error(`Error loading branches for ${projectId}:`, error);
            selectEl.innerHTML = '<option value="main">main (fallback)</option>';
            checkLatestBuildStatus(projectId, buildConfig, 'main');
            loadLastSuccessfulBuilds(projectId, buildConfig, 'main');
        }
    }

    // Check latest build status
    async function checkLatestBuildStatus(projectId, buildConfig, branch) {
        try {
            const response = await fetch(`/api/build/latest?configId=${buildConfig}&branch=${branch}`);
            const infoBtn = document.getElementById(`info-build-${projectId}`);
            if (response.ok) {
                const data = await response.json();
                updateBuildBadge(projectId, data.status, data.state);
                
                // Cache build info & show info button
                jobDetailsCache[`${projectId}-build`] = data;
                if (infoBtn) infoBtn.style.display = 'inline-flex';
            } else {
                // If no builds found, reset badges
                updateBuildBadge(projectId, 'NO STATUS', 'inactive');
                if (infoBtn) infoBtn.style.display = 'none';
            }
        } catch (error) {
            console.error('Error fetching latest build status:', error);
        }
    }

    // Trigger Code Build
    async function triggerBuild(projectId, configId, branch) {
        const buildBtn = document.getElementById(`build-btn-${projectId}`);
        const deployBtn = document.getElementById(`deploy-btn-${projectId}`);
        
        buildBtn.disabled = true;
        deployBtn.disabled = true; // lock deploy during active build
        
        showToast(`Triggering build for branch: ${branch}`, 'info');
        
        try {
            const response = await fetch('/api/build/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configId, branch })
            });
            
            if (response.ok) {
                const data = await response.json();
                showToast(`Build ${data.number} triggered successfully!`, 'success');
                startPolling(projectId, data.id, 'build');
            } else {
                showToast('Failed to trigger build. Check TeamCity logs.', 'error');
                buildBtn.disabled = false;
            }
        } catch (error) {
            console.error('Error triggering build:', error);
            showToast('Error connecting to Server.', 'error');
            buildBtn.disabled = false;
        }
    }

    // Load last 10 successful builds into the dropdown
    async function loadLastSuccessfulBuilds(projectId, buildConfig, branch) {
        const selectEl = document.getElementById(`build-version-${projectId}`);
        const deployBtn = document.getElementById(`deploy-btn-${projectId}`);
        if (!selectEl) return;

        selectEl.innerHTML = '<option value="">Loading versions...</option>';
        deployBtn.disabled = true;

        try {
            const response = await fetch(`/api/build/last-success-list?configId=${buildConfig}&branch=${branch}`);
            if (response.ok) {
                const builds = await response.json();
                selectEl.innerHTML = '';

                if (builds && builds.length > 0) {
                    builds.forEach(build => {
                        const opt = document.createElement('option');
                        opt.value = build.number;
                        opt.innerText = build.number;
                        selectEl.appendChild(opt);
                    });
                    deployBtn.disabled = false;
                } else {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.innerText = 'No successful builds found';
                    selectEl.appendChild(opt);
                    deployBtn.disabled = true;
                }
            } else {
                throw new Error('Failed to load successful builds');
            }
        } catch (error) {
            console.error(`Error loading successful builds for ${projectId}:`, error);
            selectEl.innerHTML = '<option value="">Error loading versions</option>';
            deployBtn.disabled = true;
        }
    }

    // Trigger Deployment
    async function triggerDeploy(projectId, configId, branch, environment, buildNumber) {
        const deployBtn = document.getElementById(`deploy-btn-${projectId}`);
        const buildBtn = document.getElementById(`build-btn-${projectId}`);
        
        deployBtn.disabled = true;
        buildBtn.disabled = true; // Lock build during deployment
        
        showToast(`Deploying build ${buildNumber} on branch ${branch} to OpenShift [${environment.toUpperCase()}]`, 'info');
        
        try {
            const response = await fetch('/api/deploy/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configId, branch, environment, buildNumber })
            });
            
            if (response.ok) {
                const data = await response.json();
                showToast(`Deploy ${data.number} started.`, 'success');
                startPolling(projectId, data.id, 'deploy');
            } else {
                showToast('Deployment trigger failed.', 'error');
                deployBtn.disabled = false;
                buildBtn.disabled = false;
            }
        } catch (error) {
            console.error('Error triggering deployment:', error);
            showToast('Error connecting to Server.', 'error');
            deployBtn.disabled = false;
            buildBtn.disabled = false;
        }
    }

    // Start Polling Loop for a given build ID
    function startPolling(projectId, buildId, type) {
        const key = `${projectId}-${type}`;
        
        // Clear previous poll for this specific area if exists
        if (activePolls[key]) {
            clearInterval(activePolls[key]);
        }
        
        const liveInfo = document.getElementById(`${type}-live-${projectId}`);
        liveInfo.style.display = 'block';

        // Track active job ID
        activeJobs[key] = buildId;

        // Poll immediately and then set interval
        pollStatus(projectId, buildId, type);
        activePolls[key] = setInterval(() => pollStatus(projectId, buildId, type), 5000);
    }

    // Single Poll invocation
    async function pollStatus(projectId, buildId, type) {
        const key = `${projectId}-${type}`;
        
        try {
            const response = await fetch(`/api/build/status/${buildId}`);
            if (!response.ok) return;
            
            const data = await response.json();
            
            // Elements
            const badge = document.getElementById(`${type}-badge-${projectId}`);
            const timerContainer = document.getElementById(`${type}-timer-${projectId}`);
            const progressWrap = document.getElementById(`${type}-progress-wrap-${projectId}`);
            const progressBar = progressWrap.querySelector('.progress-bar');
            const infoText = document.querySelector(`#${type}-live-${projectId} .info-text`);
            const pctText = document.querySelector(`#${type}-live-${projectId} .pct-text`);
            const cancelBtn = document.getElementById(`cancel-${type}-${projectId}`);
            const durationWrap = document.getElementById(`${type}-duration-wrap-${projectId}`);
            const durationEl = document.getElementById(`${type}-duration-${projectId}`);
            
            updateBadgeStyle(badge, data.status, data.state);
            
            // Cache current details and show info button
            jobDetailsCache[key] = data;
            const infoBtn = document.getElementById(`info-${type}-${projectId}`);
            if (infoBtn) infoBtn.style.display = 'inline-flex';
            
            let statusLabel = type === 'build' ? 'Build' : 'Deploy';
            let displayMsg = data.statusText || 'Executing...';
            if (data.number) {
                displayMsg = `${statusLabel} ${data.number}: ${displayMsg}`;
            }
            infoText.innerText = displayMsg;
            
            if (data.state === 'queued') {
                // Show timer
                timerContainer.style.display = 'flex';
                progressWrap.style.display = 'none';
                pctText.innerText = 'Queued';
                
                if (cancelBtn) cancelBtn.style.display = 'inline-flex';
                if (durationWrap) durationWrap.style.display = 'none';
                
                // Start or update countdown
                if (data.waitEstimate) {
                    setupCountdown(projectId, type, data.waitEstimate);
                } else {
                    timerContainer.querySelector('.timer-clock').innerText = '00:00';
                }
            } else if (data.state === 'running') {
                // Show progress bar
                timerContainer.style.display = 'none';
                progressWrap.style.display = 'block';
                
                if (cancelBtn) cancelBtn.style.display = 'inline-flex';
                if (durationWrap) {
                    durationWrap.style.display = 'inline-flex';
                    if (durationEl) durationEl.innerText = formatDuration(data.duration);
                }
                
                // Clear any leftover countdown
                clearCountdown(projectId, type);
                
                const pct = data.percentageComplete || 0;
                progressBar.style.width = `${pct}%`;
                pctText.innerText = `${pct}%`;
            } else if (data.state === 'finished') {
                // Done!
                timerContainer.style.display = 'none';
                progressWrap.style.display = 'block';
                progressBar.style.width = '100%';
                pctText.innerText = '100%';
                
                if (cancelBtn) cancelBtn.style.display = 'none';
                if (durationWrap) {
                    durationWrap.style.display = 'inline-flex';
                    if (durationEl) durationEl.innerText = formatDuration(data.duration);
                }
                
                // Clear active job ID
                delete activeJobs[key];
                
                // Clear interval
                clearInterval(activePolls[key]);
                delete activePolls[key];
                clearCountdown(projectId, type);
                
                // Restore primary button triggers
                document.getElementById(`build-btn-${projectId}`).disabled = false;
                
                if (type === 'build') {
                    const branchSelect = document.getElementById(`branch-${projectId}`);
                    const branch = branchSelect ? branchSelect.value : 'main';
                    const card = document.querySelector(`.project-card[data-project-id="${projectId}"]`);
                    const buildConfig = card ? card.dataset.buildConfig : '';
                    if (data.status === 'SUCCESS') {
                        showToast(`Build succeeded!`, 'success');
                        loadLastSuccessfulBuilds(projectId, buildConfig, branch);
                    } else {
                        showToast(`Build failed!`, 'error');
                        loadLastSuccessfulBuilds(projectId, buildConfig, branch);
                    }
                } else {
                    // Deployment finished
                    document.getElementById(`deploy-btn-${projectId}`).disabled = false;
                    if (data.status === 'SUCCESS') {
                        showToast(`Deployment completed successfully to OpenShift!`, 'success');
                    } else {
                        showToast(`Deployment failed!`, 'error');
                    }
                }
                
                // Hide live panel after 10 seconds of completion
                setTimeout(() => {
                    if (!activePolls[key]) {
                        document.getElementById(`${type}-live-${projectId}`).style.display = 'none';
                    }
                }, 10000);
            }
        } catch (error) {
            console.error('Error polling status:', error);
        }
    }

    // Cancel an active build or deployment job
    async function cancelJob(projectId, buildId, type) {
        showToast(`Requesting cancellation for ${type}...`, 'info');
        try {
            const response = await fetch(`/api/build/cancel/${buildId}`, {
                method: 'POST'
            });
            if (response.ok) {
                showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} cancellation request sent.`, 'success');
                // Poll immediately to fetch canceled state
                pollStatus(projectId, buildId, type);
            } else {
                showToast(`Failed to cancel ${type}.`, 'error');
            }
        } catch (error) {
            console.error(`Error canceling ${type}:`, error);
            showToast(`Error connecting to server to cancel ${type}.`, 'error');
        }
    }

    // Format seconds into a TeamCity-style duration string (e.g. 1m 30s or 45s)
    function formatDuration(seconds) {
        if (seconds === undefined || seconds === null || isNaN(seconds) || seconds < 0) {
            return '0s';
        }
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        
        let result = '';
        if (h > 0) result += `${h}h `;
        if (m > 0 || h > 0) result += `${m}m `;
        result += `${s}s`;
        return result.trim();
    }

    // Populate and show the modal with detailed job status information
    function showJobDetails(cacheKey) {
        const data = jobDetailsCache[cacheKey];
        if (!data) {
            showToast('No details available for this job yet.', 'info');
            return;
        }

        const modal = document.getElementById('info-modal');
        const modalTitle = document.getElementById('modal-title');
        const configIdEl = document.getElementById('modal-build-config-id');
        const numberLabelEl = document.getElementById('modal-build-number-label');
        const numberEl = document.getElementById('modal-build-number');
        const branchEl = document.getElementById('modal-branch');
        const statusEl = document.getElementById('modal-status');
        const stateEl = document.getElementById('modal-state');
        const durationEl = document.getElementById('modal-duration');
        const triggeredByEl = document.getElementById('modal-triggered-by');
        const reasonSection = document.getElementById('modal-reason-section');
        const reasonTextEl = document.getElementById('modal-reason-text');
        const tcLink = document.getElementById('modal-tc-link');
        const lastSuccessBuildEl = document.getElementById('modal-last-success-build');
        const lastSuccessWrap = document.getElementById('modal-last-success-wrap');

        // Determine title
        const type = cacheKey.endsWith('-build') ? 'Code Build' : 'OpenShift Deploy';
        modalTitle.innerText = `${type} Details`;
        configIdEl.innerText = data.buildTypeId || 'N/A';
        
        if (numberLabelEl) {
            numberLabelEl.innerText = type === 'Code Build' ? 'Latest Build Number' : 'Latest Deploy Number';
        }
        numberEl.innerText = data.number || 'N/A';
        branchEl.innerText = data.branchName || 'N/A';

        // Set status and apply classes
        statusEl.className = 'status-badge'; // reset
        if (data.state === 'queued') {
            statusEl.innerText = 'QUEUED';
            statusEl.classList.add('status-queued');
        } else if (data.state === 'running') {
            statusEl.innerText = 'RUNNING';
            statusEl.classList.add('status-running');
        } else {
            const upperStatus = (data.status || '').toUpperCase();
            statusEl.innerText = upperStatus || 'UNKNOWN';
            if (upperStatus === 'SUCCESS') {
                statusEl.classList.add('status-success');
            } else if (upperStatus === 'FAILURE' || upperStatus === 'FAILED' || upperStatus === 'ERROR') {
                statusEl.classList.add('status-failure');
                statusEl.innerText = upperStatus === 'FAILURE' ? 'FAILED' : upperStatus;
            } else if (upperStatus === 'CANCELED') {
                statusEl.classList.add('status-canceled');
                statusEl.innerText = 'CANCELED';
            } else if (upperStatus === '' || upperStatus === 'NO STATUS') {
                statusEl.classList.add('status-inactive');
                statusEl.innerText = 'NO STATUS';
            } else {
                statusEl.classList.add('status-inactive');
                statusEl.innerText = upperStatus;
            }
        }

        stateEl.innerText = data.state ? data.state.toUpperCase() : 'UNKNOWN';
        durationEl.innerText = formatDuration(data.duration);
        if (triggeredByEl) {
            triggeredByEl.innerText = data.triggeredBy || 'N/A';
        }

        // Display status description/reason if available
        if (data.statusText) {
            reasonSection.style.display = 'flex';
            reasonTextEl.innerText = data.statusText;
        } else {
            reasonSection.style.display = 'none';
        }

        // Setup link to TeamCity web UI
        if (data.webUrl) {
            tcLink.href = data.webUrl;
            tcLink.style.display = 'inline-flex';
        } else {
            tcLink.style.display = 'none';
        }

        // Fetch and show last success build number (only for Code Build)
        if (lastSuccessWrap) {
            if (type === 'Code Build') {
                lastSuccessWrap.style.display = 'flex';
                if (lastSuccessBuildEl) {
                    lastSuccessBuildEl.innerText = 'Loading...';
                    
                    const configId = data.buildTypeId;
                    const branch = data.branchName || '';
                    
                    // Track configId & branch to check against race conditions
                    lastSuccessBuildEl.dataset.configId = configId;
                    lastSuccessBuildEl.dataset.branch = branch;

                    fetch(`/api/build/last-success?configId=${encodeURIComponent(configId)}&branch=${encodeURIComponent(branch)}`)
                        .then(response => {
                            if (response.status === 204) {
                                return null;
                            }
                            if (response.ok) {
                                return response.text().then(text => text ? JSON.parse(text) : null);
                            }
                            throw new Error('Not found');
                        })
                        .then(successData => {
                            if (lastSuccessBuildEl.dataset.configId === configId && lastSuccessBuildEl.dataset.branch === branch) {
                                if (successData && successData.number) {
                                    lastSuccessBuildEl.innerText = successData.number;
                                } else {
                                    lastSuccessBuildEl.innerText = 'None';
                                }
                            }
                        })
                        .catch(err => {
                            console.error('Error fetching last success build:', err);
                            if (lastSuccessBuildEl.dataset.configId === configId && lastSuccessBuildEl.dataset.branch === branch) {
                                lastSuccessBuildEl.innerText = 'None';
                            }
                        });
                }
            } else {
                lastSuccessWrap.style.display = 'none';
            }
        }

        // Show modal
        modal.style.display = 'flex';
    }

    // Manage client-side countdown ticking
    function setupCountdown(projectId, type, initialSeconds) {
        const timerClock = document.querySelector(`#${type}-timer-${projectId} .timer-clock`);
        const timerKey = `${projectId}-${type}`;
        
        if (countdownIntervals[timerKey]) {
            clearInterval(countdownIntervals[timerKey]);
        }
        
        let secondsLeft = initialSeconds;
        
        const updateDisplay = (secs) => {
            const m = Math.floor(secs / 60).toString().padStart(2, '0');
            const s = (secs % 60).toString().padStart(2, '0');
            timerClock.innerText = `${m}:${s}`;
        };
        
        updateDisplay(secondsLeft);
        
        countdownIntervals[timerKey] = setInterval(() => {
            secondsLeft--;
            if (secondsLeft <= 0) {
                clearInterval(countdownIntervals[timerKey]);
                timerClock.innerText = '00:00';
            } else {
                updateDisplay(secondsLeft);
            }
        }, 1000);
    }

    function clearCountdown(projectId, type) {
        const timerKey = `${projectId}-${type}`;
        if (countdownIntervals[timerKey]) {
            clearInterval(countdownIntervals[timerKey]);
            delete countdownIntervals[timerKey];
        }
    }

    // Helper functions to update badge states & classes
    function updateBuildBadge(projectId, status, state) {
        const badge = document.getElementById(`build-badge-${projectId}`);
        if (badge) {
            updateBadgeStyle(badge, status, state);
        }
    }

    function updateBadgeStyle(badge, status, state) {
        badge.className = 'status-badge'; // reset
        
        if (state === 'queued') {
            badge.classList.add('status-queued');
            badge.innerText = 'QUEUED';
        } else if (state === 'running') {
            badge.classList.add('status-running');
            badge.innerText = 'RUNNING';
        } else {
            const upperStatus = (status || '').toUpperCase();
            if (upperStatus === 'SUCCESS') {
                badge.classList.add('status-success');
                badge.innerText = 'SUCCESS';
            } else if (upperStatus === 'FAILURE' || upperStatus === 'FAILED' || upperStatus === 'ERROR') {
                badge.classList.add('status-failure');
                badge.innerText = upperStatus === 'FAILURE' ? 'FAILED' : upperStatus;
            } else if (upperStatus === 'CANCELED') {
                badge.classList.add('status-canceled');
                badge.innerText = 'CANCELED';
            } else if (upperStatus === 'QUEUED') {
                badge.classList.add('status-queued');
                badge.innerText = 'QUEUED';
            } else if (upperStatus === 'RUNNING') {
                badge.classList.add('status-running');
                badge.innerText = 'RUNNING';
            } else if (upperStatus === '' || upperStatus === 'NO STATUS') {
                badge.classList.add('status-inactive');
                badge.innerText = 'NO STATUS';
            } else {
                badge.classList.add('status-inactive');
                badge.innerText = upperStatus;
            }
        }
    }

    // 2. Server Status Page Logic
    const statusPageContainer = document.querySelector('.status-stats-grid');
    const uptimeHistoryCache = {};
    const currentStates = {};

    if (statusPageContainer) {
        initStatusPage();
    }

    function initStatusPage() {
        const searchInput = document.getElementById('status-search-input');
        const envFilter = document.getElementById('status-env-filter');
        const tableBtn = document.getElementById('layout-table-btn');
        const gridBtn = document.getElementById('layout-grid-btn');
        const tableView = document.getElementById('table-view-container');
        const gridView = document.getElementById('grid-view-container');
        const refreshBtn = document.getElementById('refresh-all-btn');

        // Layout Toggle Event Listeners
        tableBtn.addEventListener('click', () => {
            tableBtn.classList.add('active');
            gridBtn.classList.remove('active');
            tableView.style.display = 'block';
            gridView.style.display = 'none';
        });

        gridBtn.addEventListener('click', () => {
            gridBtn.classList.add('active');
            tableBtn.classList.remove('active');
            gridView.style.display = 'grid';
            tableView.style.display = 'none';
        });

        // Search Input Listener
        searchInput.addEventListener('input', filterDashboard);

        // Env Filter Listener
        envFilter.addEventListener('change', () => {
            filterDashboard();
            applyEnvironmentColumnFilter();
        });

        // Refresh button
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                checkAllServerStatus();
            });
        }

        // Initialize uptime history cache with mock data
        const rows = document.querySelectorAll('.project-status-row');
        rows.forEach(row => {
            const projectId = row.dataset.projectId;
            const cells = row.querySelectorAll('.status-cell');
            cells.forEach(cell => {
                const env = cell.dataset.env;
                const cacheKey = `${projectId}-${env}`;
                // Generate 11 historical checks (90% success rate)
                const history = [];
                for (let i = 0; i < 11; i++) {
                    history.push(Math.random() < 0.92);
                }
                uptimeHistoryCache[cacheKey] = history;
            });
        });

        // Initial poll
        checkAllServerStatus();
    }

    function filterDashboard() {
        const query = document.getElementById('status-search-input').value.toLowerCase().trim();
        
        // 1. Filter Table Rows
        const tableRows = document.querySelectorAll('.project-status-row');
        tableRows.forEach(row => {
            const name = row.querySelector('.proj-name').innerText.toLowerCase();
            const id = row.dataset.projectId.toLowerCase();
            const matchesSearch = name.includes(query) || id.includes(query);
            row.style.display = matchesSearch ? '' : 'none';
        });

        // 2. Filter Grid Cards
        const gridCards = document.querySelectorAll('.project-status-card');
        gridCards.forEach(card => {
            const name = card.querySelector('.service-card-title').innerText.toLowerCase();
            const id = card.dataset.projectId.toLowerCase();
            const matchesSearch = name.includes(query) || id.includes(query);
            card.style.display = matchesSearch ? '' : 'none';
        });
    }

    function applyEnvironmentColumnFilter() {
        const selectedEnv = document.getElementById('status-env-filter').value;

        // 1. Table Column Filtering
        const table = document.querySelector('.status-matrix-table');
        if (table) {
            const headers = table.querySelectorAll('thead th');
            const rows = table.querySelectorAll('tbody tr');

            // Hide/Show headers (Project is index 0)
            headers.forEach((th, idx) => {
                if (idx === 0) return;
                const envName = th.innerText.toLowerCase();
                th.style.display = (selectedEnv === 'all' || envName === selectedEnv) ? '' : 'none';
            });

            // Hide/Show cells
            rows.forEach(row => {
                const cells = row.querySelectorAll('.status-cell');
                cells.forEach(cell => {
                    const cellEnv = cell.dataset.env.toLowerCase();
                    cell.style.display = (selectedEnv === 'all' || cellEnv === selectedEnv) ? '' : 'none';
                });
            });
        }

        // 2. Card Row Filtering
        const cardRows = document.querySelectorAll('.env-health-row');
        cardRows.forEach(row => {
            const rowEnv = row.dataset.env.toLowerCase();
            row.style.display = (selectedEnv === 'all' || rowEnv === selectedEnv) ? 'flex' : 'none';
        });
    }

    function checkAllServerStatus() {
        showToast('Refreshing server health checks...', 'info');
        
        // Reset states to checking
        const rows = document.querySelectorAll('.project-status-row');
        rows.forEach(row => {
            const projectId = row.dataset.projectId;
            const cells = row.querySelectorAll('.status-cell');
            cells.forEach(cell => {
                const env = cell.dataset.env;
                currentStates[`${projectId}-${env}`] = null;
            });
        });
        updateStatsOverview();

        // Trigger asynchronous health checks
        rows.forEach(row => {
            const projectId = row.dataset.projectId;
            const cells = row.querySelectorAll('.status-cell');
            cells.forEach(cell => {
                const env = cell.dataset.env;
                pollServerHealth(projectId, env);
            });
        });
    }

    async function pollServerHealth(projectId, env) {
        const tableCell = document.getElementById(`cell-${projectId}-${env}`);
        const cardRow = document.getElementById(`card-row-${projectId}-${env}`);

        // Table Elements
        const tablePill = tableCell ? tableCell.querySelector('.status-pill') : null;
        const tableTooltip = tableCell ? tableCell.querySelector('.endpoint-tooltip') : null;

        // Card Elements
        const cardPill = cardRow ? cardRow.querySelector('.status-pill') : null;
        const cardTooltip = cardRow ? cardRow.querySelector('.endpoint-tooltip') : null;
        const cardHistory = cardRow ? cardRow.querySelector('.uptime-history-wrap') : null;

        // Resolve Swagger URL from dataset
        const baseUrl = tableCell ? tableCell.dataset.url : (cardRow ? cardRow.dataset.url : null);
        let swaggerUrl = null;
        if (baseUrl && baseUrl !== 'N/A') {
            try {
                const parsedUrl = new URL(baseUrl);
                swaggerUrl = parsedUrl.origin + '/swagger/index.html';
            } catch (err) {
                console.error('Invalid baseUrl for Swagger:', baseUrl, err);
            }
        }

        const bindPillClick = (pill) => {
            if (!pill) return;
            if (swaggerUrl) {
                pill.onclick = () => window.open(swaggerUrl, '_blank');
                pill.style.cursor = 'pointer';
            } else {
                pill.onclick = null;
                pill.style.cursor = 'default';
            }
        };

        // Set to checking states
        if (tablePill) {
            tablePill.className = 'status-pill checking';
            tablePill.innerText = 'CHECKING';
            bindPillClick(tablePill);
        }
        if (tableTooltip) {
            tableTooltip.innerText = 'Querying endpoint...';
        }

        if (cardPill) {
            cardPill.className = 'status-pill checking';
            cardPill.innerText = 'CHECKING';
            bindPillClick(cardPill);
        }
        if (cardTooltip) {
            cardTooltip.innerText = 'Querying endpoint...';
        }
        if (cardHistory) {
            const blocks = cardHistory.querySelectorAll('.uptime-block');
            if (blocks.length > 0) {
                blocks[blocks.length - 1].className = 'uptime-block block-checking';
            }
        }

        const cacheKey = `${projectId}-${env}`;
        let history = uptimeHistoryCache[cacheKey] || [];

        try {
            const response = await fetch(`/api/projects/${projectId}/health/${env}`);
            if (response.ok) {
                const data = await response.json();
                const isUp = data.status === 'UP';
                currentStates[cacheKey] = isUp;
                
                // Update history cache
                if (history.length >= 11) {
                    history.shift();
                }
                history.push(isUp);
                uptimeHistoryCache[cacheKey] = history;

                // Compute Uptime
                const upBlocks = history.filter(val => val === true).length;
                const totalBlocks = history.length;
                const uptimePct = totalBlocks > 0 ? Math.round((upBlocks / totalBlocks) * 100) : 100;

                const pillClass = isUp ? 'status-pill up' : 'status-pill down';
                const pillText = isUp ? 'UP' : 'DOWN';

                // Build HTML Tooltip (with proper click navigation)
                const tooltipHtml = `
                    <div style="text-align: left; line-height: 1.5; pointer-events: auto;">
                        <strong>Homepage:</strong> <a href="${data.url}" target="_blank" style="color: var(--accent-blue); text-decoration: underline;">${data.url}</a><br/>
                        <strong>Health:</strong> <a href="${data.healthUrl}" target="_blank" style="color: var(--text-secondary); text-decoration: underline;">${data.healthUrl}</a><br/>
                        <strong>Status:</strong> ${isUp ? '<span style="color: var(--status-success)">200 OK</span>' : '<span style="color: var(--status-failure)">Connection Error</span>'}<br/>
                        <strong>Uptime Score:</strong> ${uptimePct}%
                    </div>
                `;

                // Render Uptime sparkline blocks
                let sparkHtml = '';
                history.forEach(h => {
                    sparkHtml += `<div class="uptime-block ${h ? 'block-up' : 'block-down'}"></div>`;
                });
                for (let i = history.length; i < 12; i++) {
                    sparkHtml += '<div class="uptime-block"></div>';
                }
                sparkHtml += `<span class="uptime-percentage">${uptimePct}%</span>`;

                // Apply changes to matrix table cells
                if (tablePill) {
                    tablePill.className = pillClass;
                    tablePill.innerText = pillText;
                }
                if (tableTooltip) {
                    tableTooltip.innerHTML = tooltipHtml;
                }

                // Apply changes to grid cards row
                if (cardPill) {
                    cardPill.className = pillClass;
                    cardPill.innerText = pillText;
                }
                if (cardTooltip) {
                    cardTooltip.innerHTML = tooltipHtml;
                }
                if (cardHistory) {
                    cardHistory.innerHTML = sparkHtml;
                }
            } else {
                throw new Error('Endpoint returned error status');
            }
        } catch (error) {
            currentStates[cacheKey] = false;
            if (history.length >= 11) {
                history.shift();
            }
            history.push(false);
            uptimeHistoryCache[cacheKey] = history;

            const upBlocks = history.filter(val => val === true).length;
            const uptimePct = history.length > 0 ? Math.round((upBlocks / history.length) * 100) : 0;

            const tooltipHtml = `
                <div style="text-align: left; line-height: 1.5; pointer-events: auto;">
                    <strong>Homepage:</strong> <span style="color: var(--text-secondary)">Unavailable</span><br/>
                    <strong>Health:</strong> <span style="color: var(--text-secondary)">Unavailable</span><br/>
                    <strong>Status:</strong> <span style="color: var(--status-failure)">HTTP 503 Service Unavailable</span><br/>
                    <strong>Uptime Score:</strong> ${uptimePct}%
                </div>
            `;

            let sparkHtml = '';
            history.forEach(h => {
                sparkHtml += `<div class="uptime-block ${h ? 'block-up' : 'block-down'}"></div>`;
            });
            for (let i = history.length; i < 12; i++) {
                sparkHtml += '<div class="uptime-block"></div>';
            }
            sparkHtml += `<span class="uptime-percentage">${uptimePct}%</span>`;

            if (tablePill) {
                tablePill.className = 'status-pill down';
                tablePill.innerText = 'DOWN';
            }
            if (tableTooltip) {
                tableTooltip.innerHTML = tooltipHtml;
            }

            if (cardPill) {
                cardPill.className = 'status-pill down';
                cardPill.innerText = 'DOWN';
            }
            if (cardTooltip) {
                cardTooltip.innerHTML = tooltipHtml;
            }
            if (cardHistory) {
                cardHistory.innerHTML = sparkHtml;
            }
        }

        updateStatsOverview();
    }

    function updateStatsOverview() {
        let total = 0;
        let upCount = 0;
        let downCount = 0;

        Object.values(currentStates).forEach(val => {
            if (val !== null) {
                total++;
                if (val === true) {
                    upCount++;
                } else {
                    downCount++;
                }
            }
        });

        const totalMonitoredEl = document.getElementById('stat-total-monitored');
        const servicesUpEl = document.getElementById('stat-services-up');
        const servicesDownEl = document.getElementById('stat-services-down');
        const healthIndexEl = document.getElementById('stat-health-index');

        if (totalMonitoredEl) totalMonitoredEl.innerText = total;
        if (servicesUpEl) servicesUpEl.innerText = upCount;
        if (servicesDownEl) servicesDownEl.innerText = downCount;
        
        if (healthIndexEl) {
            if (total === 0) {
                healthIndexEl.innerText = '100%';
                healthIndexEl.style.color = 'var(--text-primary)';
            } else {
                const percentage = Math.round((upCount / total) * 100);
                healthIndexEl.innerText = `${percentage}%`;
                if (percentage >= 90) {
                    healthIndexEl.style.color = 'var(--status-success)';
                } else if (percentage >= 70) {
                    healthIndexEl.style.color = 'var(--status-queued)';
                } else {
                    healthIndexEl.style.color = 'var(--status-failure)';
                }
            }
        }
    }

    // Custom Glassmorphic Toast Notifications
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        
        // Custom borders based on type
        if (type === 'success') {
            toast.style.borderLeftColor = 'var(--status-success)';
        } else if (type === 'error') {
            toast.style.borderLeftColor = 'var(--status-failure)';
        } else if (type === 'warning') {
            toast.style.borderLeftColor = 'var(--status-queued)';
        }
        
        toast.innerHTML = `
            <span class="toast-message">${message}</span>
        `;
        
        container.appendChild(toast);
        
        // Remove toast after 4s
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
});
