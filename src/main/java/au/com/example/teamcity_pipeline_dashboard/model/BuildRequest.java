package au.com.example.teamcity_pipeline_dashboard.model;

import lombok.Data;

@Data
public class BuildRequest {
    private String configId;
    private String branch;
    private String environment;
    private String buildNumber;
}
