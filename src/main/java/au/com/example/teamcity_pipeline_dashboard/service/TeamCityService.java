package au.com.example.teamcity_pipeline_dashboard.service;

import au.com.example.teamcity_pipeline_dashboard.config.TeamCityProperties;
import au.com.example.teamcity_pipeline_dashboard.model.BuildResponse;
import au.com.example.teamcity_pipeline_dashboard.model.MockBuild;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Service
public class TeamCityService {

    private final WebClient webClient;
    private final TeamCityProperties properties;
    
    // In-memory store for simulated mock builds when real TeamCity is unreachable
    private final Map<String, MockBuild> mockBuilds = new ConcurrentHashMap<>();
    private final Random random = new Random();

    public TeamCityService(WebClient webClient, TeamCityProperties properties) {
        this.webClient = webClient;
        this.properties = properties;
    }

    public Mono<BuildResponse> triggerBuild(String configId, String branch, String environment, String buildNumber) {
        Map<String, Object> payload = new HashMap<>();
        
        Map<String, String> buildTypeMap = new HashMap<>();
        buildTypeMap.put("id", configId);
        payload.put("buildType", buildTypeMap);
        
        if (branch != null && !branch.isEmpty()) {
            payload.put("branchName", branch);
        }

        Map<String, Object> propsMap = new HashMap<>();
        List<Map<String, String>> propList = new ArrayList<>();

        if (environment != null && !environment.isEmpty()) {
            Map<String, String> envProp = new HashMap<>();
            envProp.put("name", "env");
            envProp.put("value", environment);
            propList.add(envProp);
        }

        if (buildNumber != null && !buildNumber.isEmpty()) {
            Map<String, String> numProp = new HashMap<>();
            numProp.put("name", "build.number");
            numProp.put("value", buildNumber);
            propList.add(numProp);
        }

        if (!propList.isEmpty()) {
            propsMap.put("property", propList);
            payload.put("properties", propsMap);
        }

        return webClient.post()
                .uri("/app/rest/buildQueue")
                .bodyValue(payload)
                .retrieve()
                .bodyToMono(BuildResponse.class)
                .onErrorResume(e -> {
                    log.warn("Failed to connect to real TeamCity at {}. Falling back to simulation mode. Error: {}", 
                            properties.getUrl(), e.getMessage());
                    boolean isDeploy = environment != null && !environment.isEmpty();
                    return Mono.just(createMockBuild(configId, branch, environment, buildNumber, isDeploy));
                });
    }

    public Mono<BuildResponse> getBuildStatus(String buildId) {
        if (mockBuilds.containsKey(buildId)) {
            return Mono.just(updateAndGetMockBuildResponse(buildId));
        }

        // Try to fetch from buildQueue first, then fallback to builds
        return webClient.get()
                .uri("/app/rest/buildQueue/id:" + buildId)
                .retrieve()
                .bodyToMono(BuildResponse.class)
                .onErrorResume(e -> webClient.get()
                        .uri("/app/rest/builds/id:" + buildId)
                        .retrieve()
                        .bodyToMono(BuildResponse.class)
                )
                .map(this::enrichBuildResponse)
                .onErrorResume(e -> {
                    log.warn("Failed to fetch real build status for id: {}. Trying mock cache.", buildId);
                    if (mockBuilds.containsKey(buildId)) {
                        return Mono.just(updateAndGetMockBuildResponse(buildId));
                    }
                    // Return a basic mock build if not found in cache
                    return Mono.just(createMockBuild("Unknown_Build", "main", null, null, false));
                });
    }

    @SuppressWarnings("unchecked")
    public Mono<BuildResponse> getLatestBuild(String configId, String branch) {
        // Get the latest build (running, finished, canceled, etc.) for this configuration and branch
        String uri = "/app/rest/builds?locator=buildType:" + configId + 
                     (branch != null && !branch.isEmpty() ? ",branch:" + branch : "") + 
                     ",count:1,defaultFilter:false";
        
        return webClient.get()
                .uri(uri)
                .retrieve()
                .bodyToMono(Map.class)
                .flatMap(map -> {
                    List<Map<String, Object>> builds = (List<Map<String, Object>>) map.get("build");
                    if (builds != null && !builds.isEmpty()) {
                        String id = String.valueOf(builds.get(0).get("id"));
                        return getBuildStatus(id);
                    }
                    return Mono.empty();
                })
                .onErrorResume(e -> {
                    // Find latest in mock list
                    return mockBuilds.values().stream()
                            .filter(mb -> mb.getBuildTypeId().equals(configId) && 
                                          (branch == null || mb.getBranchName().equals(branch)))
                            .max(Comparator.comparing(mb -> mb.getTriggerTime()))
                            .map(mb -> Mono.just(updateAndGetMockBuildResponse(mb.getId())))
                            .orElse(Mono.empty());
                });
     }

    @SuppressWarnings("unchecked")
    public Mono<BuildResponse> getLastSuccessfulBuild(String configId, String branch) {
        // Query the latest finished build with status SUCCESS
        String uri = "/app/rest/builds?locator=buildType:" + configId + 
                     (branch != null && !branch.isEmpty() ? ",branch:" + branch : "") + 
                     ",status:SUCCESS,count:1,defaultFilter:false";
        
        return webClient.get()
                .uri(uri)
                .retrieve()
                .bodyToMono(Map.class)
                .flatMap(map -> {
                    List<Map<String, Object>> builds = (List<Map<String, Object>>) map.get("build");
                    if (builds != null && !builds.isEmpty()) {
                        String id = String.valueOf(builds.get(0).get("id"));
                        return getBuildStatus(id);
                    }
                    return Mono.empty();
                })
                .onErrorResume(e -> {
                    // Try getting last successful mock build from simulation cache
                    return mockBuilds.values().stream()
                            .filter(mb -> mb.getBuildTypeId().equals(configId) && 
                                          (branch == null || mb.getBranchName().equals(branch)) &&
                                          "SUCCESS".equalsIgnoreCase(mb.getStatus()))
                            .max(Comparator.comparing(mb -> mb.getTriggerTime()))
                            .map(mb -> Mono.just(updateAndGetMockBuildResponse(mb.getId())))
                            .orElse(Mono.empty());
                });
    }

    @SuppressWarnings("unchecked")
    public Mono<List<BuildResponse>> getLastSuccessfulBuilds(String configId, String branch, int count) {
        // Fetch latest N successful builds — TeamCity returns them newest-first by default.
        // We parse number/status directly from the list response to preserve that ordering
        // (calling getBuildStatus per build loses order due to async completion variance).
        String uri = "/app/rest/builds?locator=buildType:" + configId +
                     (branch != null && !branch.isEmpty() ? ",branch:" + branch : "") +
                     ",status:SUCCESS,count:" + count + ",defaultFilter:false" +
                     "&fields=build(id,number,status,branchName,buildTypeId,state)";

        return webClient.get()
                .uri(uri)
                .retrieve()
                .bodyToMono(Map.class)
                .map(map -> {
                    List<Map<String, Object>> builds = (List<Map<String, Object>>) map.get("build");
                    List<BuildResponse> list = new ArrayList<>();
                    if (builds != null) {
                        // Preserve the server-side ordering (newest first)
                        for (Map<String, Object> build : builds) {
                            BuildResponse resp = new BuildResponse();
                            resp.setId(String.valueOf(build.get("id")));
                            resp.setNumber(String.valueOf(build.getOrDefault("number", "")));
                            resp.setStatus(String.valueOf(build.getOrDefault("status", "SUCCESS")));
                            resp.setState(String.valueOf(build.getOrDefault("state", "finished")));
                            resp.setBranchName(String.valueOf(build.getOrDefault("branchName", branch)));
                            resp.setBuildTypeId(configId);
                            list.add(resp);
                        }
                    }
                    return list;
                })
                .onErrorResume(e -> {
                    // Simulation mode: return mock builds sorted newest-first
                    List<BuildResponse> list = new ArrayList<>();
                    mockBuilds.values().stream()
                            .filter(mb -> mb.getBuildTypeId().equals(configId) &&
                                          (branch == null || mb.getBranchName().equals(branch)) &&
                                          "SUCCESS".equalsIgnoreCase(mb.getStatus()))
                            .sorted(Comparator.comparing((MockBuild mb) -> mb.getTriggerTime()).reversed())
                            .limit(count)
                            .forEach(mb -> list.add(updateAndGetMockBuildResponse(mb.getId())));

                    if (list.isEmpty()) {
                        // Seed 5 mock successful builds with descending build numbers (newest first)
                        int baseBuildNum = 50;
                        for (int i = 0; i < 5; i++) {
                            MockBuild mb = new MockBuild();
                            String mockId = "mock-success-" + (baseBuildNum - i);
                            mb.setId(mockId);
                            mb.setNumber("#" + (baseBuildNum - i));  // e.g. #50, #49, #48 ...
                            mb.setBuildTypeId(configId);
                            mb.setBranchName(branch != null && !branch.isEmpty() ? branch : "main");
                            mb.setTriggerTime(Instant.now().minusSeconds(3600L * (i + 1)));
                            mb.setState("finished");
                            mb.setStatus("SUCCESS");
                            mb.setDurationSeconds(25);
                            mockBuilds.put(mockId, mb);
                            list.add(updateAndGetMockBuildResponse(mockId));
                        }
                    }
                    return Mono.just(list);
                });
    }

    private BuildResponse createMockBuild(String configId, String branch, String environment, String buildNumber, boolean isDeploy) {
        String id = "mock-" + (10000 + random.nextInt(90000));
        MockBuild mb = new MockBuild();
        mb.setId(id);
        mb.setBuildTypeId(configId);
        mb.setBranchName(branch != null ? branch : "main");
        mb.setEnvironment(environment);
        mb.setBuildNumber(buildNumber);
        mb.setTriggerTime(Instant.now());
        
        // Simulating 10-15 seconds queue delay, and 20-30 seconds build duration
        mb.setQueueSeconds(12 + random.nextInt(6)); // queued phase duration
        mb.setDurationSeconds(20 + random.nextInt(15));
        mb.setState("queued");
        mb.setStatus("UNKNOWN");
        mb.setDeploy(isDeploy);
        
        mb.setStartTime(mb.getTriggerTime().plusSeconds(mb.getQueueSeconds()));
        mb.setEndTime(mb.getStartTime().plusSeconds(mb.getDurationSeconds()));
        
        mockBuilds.put(id, mb);
        log.info("Simulated mock build created: {} for {} on branch {}", id, configId, branch);
        
        return updateAndGetMockBuildResponse(id);
    }

    private BuildResponse updateAndGetMockBuildResponse(String id) {
        MockBuild mb = mockBuilds.get(id);
        if (mb == null) return null;

        Instant now = Instant.now();
        BuildResponse resp = new BuildResponse();
        resp.setId(mb.getId());
        resp.setBuildTypeId(mb.getBuildTypeId());
        resp.setBranchName(mb.getBranchName());
        // Prefer the MockBuild's own number field (set for successful-build seeds); fall back to ID-derived value
        resp.setNumber(mb.getNumber() != null ? mb.getNumber() : mb.getId().replace("mock-", "#"));
        resp.setHref("/viewBuild.html?buildId=" + mb.getId());
        resp.setWebUrl("http://localhost:8111/viewBuild.html?buildId=" + mb.getId());
        resp.setTriggeredBy("admin (Dashboard)");
        Instant triggerOrStart = mb.getStartTime() != null ? mb.getStartTime() : mb.getTriggerTime();
        if (triggerOrStart != null) {
            resp.setStartDate(triggerOrStart.toString());
        }

        if ("CANCELED".equals(mb.getStatus())) {
            resp.setState("finished");
            resp.setStatus("CANCELED");
            resp.setPercentageComplete(100);
            resp.setStatusText("Canceled by admin (Dashboard): Manually Canceled.");
            resp.setDuration((long) mb.getDurationSeconds());
            return resp;
        }

        if (now.isBefore(mb.getStartTime())) {
            // Build is queued
            mb.setState("queued");
            mb.setStatus("UNKNOWN");
            resp.setState("queued");
            resp.setStatus("UNKNOWN");
            resp.setDuration(0L);
            
            long secondsLeft = mb.getStartTime().getEpochSecond() - now.getEpochSecond();
            resp.setWaitEstimate(secondsLeft);
            resp.setStartEstimate(mb.getStartTime().toString());
            resp.setStatusText("Queued: Build will start in approx " + secondsLeft + "s");
        } else if (now.isBefore(mb.getEndTime())) {
            // Build is running
            mb.setState("running");
            mb.setStatus("UNKNOWN");
            resp.setState("running");
            resp.setStatus("UNKNOWN");
            
            long total = mb.getDurationSeconds();
            long done = now.getEpochSecond() - mb.getStartTime().getEpochSecond();
            int pct = (int) ((done * 100) / total);
            resp.setPercentageComplete(Math.min(pct, 99));
            resp.setDuration(done);
            resp.setStatusText(mb.isDeploy() ? 
                    "Deploying build " + (mb.getBuildNumber() != null ? mb.getBuildNumber() : "#50") + " to OpenShift (" + mb.getEnvironment() + ")..." : 
                    "Compiling and running tests...");
        } else {
            // Build is finished
            mb.setState("finished");
            resp.setState("finished");
            resp.setPercentageComplete(100);
            resp.setDuration((long) mb.getDurationSeconds());
            
            if ("UNKNOWN".equals(mb.getStatus())) {
                // Determine success or failure (85% success rate for builds, 95% for deploys)
                int successRate = mb.isDeploy() ? 95 : 85;
                if (random.nextInt(100) < successRate) {
                    mb.setStatus("SUCCESS");
                } else {
                    mb.setStatus("FAILURE");
                }
            }
            resp.setStatus(mb.getStatus());
            resp.setStatusText(resp.getStatus().equals("SUCCESS") ? 
                    (mb.isDeploy() ? "Deployment of build " + (mb.getBuildNumber() != null ? mb.getBuildNumber() : "#50") + " completed successfully to OpenShift." : "Build success. Tests passed.") : 
                    (mb.isDeploy() ? "Deployment of build " + (mb.getBuildNumber() != null ? mb.getBuildNumber() : "#50") + " failed. Check OpenShift logs." : "Compilation failed or tests failed."));
        }
        
        return resp;
    }

    public Mono<Void> cancelBuild(String buildId) {
        if (mockBuilds.containsKey(buildId)) {
            MockBuild mb = mockBuilds.get(buildId);
            if (mb != null) {
                mb.setState("finished");
                mb.setStatus("CANCELED");
                long elapsed = Instant.now().getEpochSecond() - mb.getStartTime().getEpochSecond();
                mb.setDurationSeconds((int) Math.max(0, elapsed));
            }
            return Mono.empty();
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("comment", "Canceled via Dashboard");
        payload.put("readdIntoQueue", false);

        return getBuildStatus(buildId)
                .map(status -> "queued".equalsIgnoreCase(status.getState()) ? 
                        "/app/rest/buildQueue/id:" + buildId : 
                        "/app/rest/builds/id:" + buildId)
                .defaultIfEmpty("/app/rest/builds/id:" + buildId)
                .onErrorReturn("/app/rest/builds/id:" + buildId)
                .flatMap(uri -> {
                    log.info("Sending cancellation request for build {} to {}", buildId, uri);
                    return webClient.post()
                            .uri(uri)
                            .bodyValue(payload)
                            .retrieve()
                            .toBodilessEntity()
                            .then();
                })
                .onErrorResume(e -> {
                    log.error("Failed to cancel build/deploy job via TeamCity for id: {}. Error: {}", buildId, e.getMessage());
                    return Mono.empty();
                });
    }

    @SuppressWarnings("unchecked")
    public Mono<List<String>> getBranches(String buildConfigId) {
        // policy:ALL_BRANCHES is required — without it TeamCity only returns the default branch
        return webClient.get()
                .uri("/app/rest/buildTypes/id:" + buildConfigId + "/branches?locator=policy:ALL_BRANCHES")
                .retrieve()
                .bodyToMono(Map.class)
                .map(map -> {
                    List<Map<String, Object>> branchList = (List<Map<String, Object>>) map.get("branch");
                    List<String> list = new ArrayList<>();
                    if (branchList != null) {
                        for (Map<String, Object> b : branchList) {
                            String name = (String) b.get("name");
                            if (name != null && !name.isBlank()) {
                                list.add(name);
                            }
                        }
                    }
                    return list;
                })
                .onErrorResume(e -> {
                    log.warn("Failed to fetch branches from TeamCity for config {}. Using mock fallback. Error: {}",
                            buildConfigId, e.getMessage());
                    // Return common branch names as simulation fallback
                    return Mono.just(Arrays.asList("main", "develop"));
                });
    }

    public Mono<String> checkHealth(String baseUrl) {
        if (baseUrl == null || baseUrl.isEmpty()) {
            return Mono.just("DOWN");
        }
        
        // Mock check for mock/example base URLs to keep the UI demo fully functional
        if (baseUrl.contains("example.com")) {
            return Mono.delay(java.time.Duration.ofMillis(300 + random.nextInt(300)))
                    .map(d -> random.nextInt(100) < 90 ? "UP" : "DOWN");
        }

        String statusUrl = baseUrl.endsWith("/") ? baseUrl + "status" : baseUrl + "/status";

        return WebClient.builder()
                .build()
                .get()
                .uri(statusUrl)
                .retrieve()
                .toBodilessEntity()
                .map(entity -> entity.getStatusCode().is2xxSuccessful() ? "UP" : "DOWN")
                .timeout(java.time.Duration.ofSeconds(2))
                .onErrorReturn("DOWN");
    }

    private BuildResponse enrichBuildResponse(BuildResponse resp) {
        if (resp == null) return null;

        // 1. Check if canceled
        if (resp.getCanceledInfo() != null) {
            resp.setStatus("CANCELED");
            resp.setState("finished");
            BuildResponse.CanceledInfo ci = resp.getCanceledInfo();
            String canceledByUser = "";
            if (ci.getUser() != null) {
                canceledByUser = " by " + (ci.getUser().getName() != null ? ci.getUser().getName() : ci.getUser().getUsername());
            }
            String commentStr = (ci.getComment() != null && !ci.getComment().isEmpty()) ? 
                    ": " + ci.getComment() : "";
            resp.setStatusText("Canceled" + canceledByUser + commentStr);
        }

        // 2. Resolve who triggered the build
        if (resp.getTriggered() != null) {
            BuildResponse.TriggeredInfo ti = resp.getTriggered();
            if ("user".equalsIgnoreCase(ti.getType()) && ti.getUser() != null) {
                resp.setTriggeredBy(ti.getUser().getName() != null ? ti.getUser().getName() : ti.getUser().getUsername());
            } else if (ti.getDetails() != null && !ti.getDetails().isEmpty()) {
                resp.setTriggeredBy(ti.getDetails());
            } else {
                String label = ti.getType();
                if ("vcs".equalsIgnoreCase(label)) label = "VCS Trigger";
                else if ("schedule".equalsIgnoreCase(label)) label = "Scheduled Trigger";
                resp.setTriggeredBy("Automatically (" + label + ")");
            }
        } else {
            resp.setTriggeredBy("System");
        }

        // 3. Extract running build info
        if (resp.getRunningInfo() != null) {
            BuildResponse.RunningInfo ri = resp.getRunningInfo();
            if (resp.getPercentageComplete() == null && ri.getPercentageComplete() != null) {
                resp.setPercentageComplete(ri.getPercentageComplete().intValue());
            }
            if (resp.getDuration() == null && ri.getElapsedSeconds() != null) {
                resp.setDuration(ri.getElapsedSeconds());
            }
            if (ri.getLeftSeconds() != null && ri.getLeftSeconds() > 0) {
                String leftStr = formatTimeLeft(ri.getLeftSeconds());
                String originalText = resp.getStatusText() != null ? resp.getStatusText() : "Running";
                // Avoid appending multiple times if it's already in the text
                if (!originalText.contains("left)")) {
                    resp.setStatusText(originalText + " (" + leftStr + " left)");
                }
            }
        }

        // 4. For finished builds, calculate duration if missing
        if ("finished".equalsIgnoreCase(resp.getState())) {
            if (resp.getDuration() == null) {
                Long computed = calculateDuration(resp.getStartDate(), resp.getFinishDate());
                if (computed != null) {
                    resp.setDuration(computed);
                }
            }
        }

        return resp;
    }

    private Long calculateDuration(String start, String finish) {
        if (start == null || start.isEmpty() || finish == null || finish.isEmpty()) {
            return null;
        }
        try {
            // TeamCity dates like 20260625T100000+0000 or 20260625T100000+0530
            java.time.format.DateTimeFormatter formatter = 
                    java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmssZ");
            java.time.ZonedDateTime startZdt = java.time.ZonedDateTime.parse(start, formatter);
            java.time.ZonedDateTime finishZdt = java.time.ZonedDateTime.parse(finish, formatter);
            return java.time.Duration.between(startZdt, finishZdt).getSeconds();
        } catch (Exception e) {
            log.warn("Failed to parse TeamCity dates: start={}, finish={}. Error: {}", start, finish, e.getMessage());
            return null;
        }
    }

    private String formatTimeLeft(Long seconds) {
        if (seconds == null || seconds <= 0) return "";
        long m = seconds / 60;
        long s = seconds % 60;
        if (m > 0) {
            return m + "m " + s + "s";
        }
        return s + "s";
    }
}
