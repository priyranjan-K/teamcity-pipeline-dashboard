package au.com.example.teamcity_pipeline_dashboard.controller;

import au.com.example.teamcity_pipeline_dashboard.config.TeamCityProperties;
import au.com.example.teamcity_pipeline_dashboard.model.ProjectConfig;
import au.com.example.teamcity_pipeline_dashboard.model.BuildRequest;
import au.com.example.teamcity_pipeline_dashboard.model.BuildResponse;
import au.com.example.teamcity_pipeline_dashboard.service.TeamCityService;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

import java.util.List;

@RestController
@RequestMapping("/api")
public class BuildApiController {

    private final TeamCityService teamCityService;
    private final TeamCityProperties properties;

    public BuildApiController(TeamCityService teamCityService, TeamCityProperties properties) {
        this.teamCityService = teamCityService;
        this.properties = properties;
    }

    @GetMapping("/projects")
    public List<ProjectConfig> getProjects() {
        return properties.getProjects();
    }

    @PostMapping("/build/trigger")
    public Mono<BuildResponse> triggerBuild(@RequestBody BuildRequest request) {
        return teamCityService.triggerBuild(request.getConfigId(), request.getBranch(), null, null);
    }

    @PostMapping("/deploy/trigger")
    public Mono<BuildResponse> triggerDeploy(@RequestBody BuildRequest request) {
        return teamCityService.triggerBuild(request.getConfigId(), request.getBranch(), request.getEnvironment(), request.getBuildNumber());
    }

    @PostMapping("/build/cancel/{buildId}")
    public Mono<Void> cancelBuild(@PathVariable String buildId) {
        return teamCityService.cancelBuild(buildId);
    }

    @GetMapping("/build/status/{buildId}")
    public Mono<BuildResponse> getBuildStatus(@PathVariable String buildId) {
        return teamCityService.getBuildStatus(buildId);
    }

    @GetMapping("/build/latest")
    public Mono<BuildResponse> getLatestBuild(@RequestParam String configId, @RequestParam(required = false) String branch) {
        return teamCityService.getLatestBuild(configId, branch);
    }

    @GetMapping("/build/last-success")
    public Mono<BuildResponse> getLastSuccessfulBuild(@RequestParam String configId, @RequestParam(required = false) String branch) {
        return teamCityService.getLastSuccessfulBuild(configId, branch);
    }

    @GetMapping("/build/last-success-list")
    public Mono<List<BuildResponse>> getLastSuccessfulBuilds(@RequestParam String configId, @RequestParam(required = false) String branch) {
        return teamCityService.getLastSuccessfulBuilds(configId, branch, 10);
    }

    @GetMapping("/projects/{projectId}/branches")
    public Mono<List<String>> getBranches(@PathVariable String projectId) {
        return properties.getProjects().stream()
                .filter(p -> p.getId().equals(projectId))
                .findFirst()
                .map(p -> teamCityService.getBranches(p.getBuildConfigId()))
                .orElse(Mono.just(java.util.Collections.emptyList()));
    }

    @GetMapping("/projects/{projectId}/health/{env}")
    public Mono<java.util.Map<String, String>> getHealth(@PathVariable String projectId, @PathVariable String env) {
        ProjectConfig project = properties.getProjects().stream()
                .filter(p -> p.getId().equals(projectId))
                .findFirst()
                .orElse(null);

        if (project == null || project.getHealthCheckUrls() == null) {
            java.util.Map<String, String> res = new java.util.HashMap<>();
            res.put("status", "DOWN");
            res.put("url", "N/A");
            res.put("healthUrl", "N/A");
            return Mono.just(res);
        }

        String baseUrl = project.getHealthCheckUrls().get(env);
        if (baseUrl == null) {
            java.util.Map<String, String> res = new java.util.HashMap<>();
            res.put("status", "DOWN");
            res.put("url", "N/A");
            res.put("healthUrl", "N/A");
            return Mono.just(res);
        }

        String statusUrl = baseUrl.endsWith("/") ? baseUrl + "status" : baseUrl + "/status";

        return teamCityService.checkHealth(baseUrl)
                .map(status -> {
                    java.util.Map<String, String> res = new java.util.HashMap<>();
                    res.put("status", status);
                    res.put("url", baseUrl);
                    res.put("healthUrl", statusUrl);
                    return res;
                });
    }
}
