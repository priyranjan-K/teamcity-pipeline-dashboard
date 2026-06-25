package au.com.example.teamcity_pipeline_dashboard.model;

import lombok.Data;
import java.util.List;
import java.util.Map;

@Data
public class ProjectConfig {
    private String id;
    private String name;
    private List<String> environments;
    private String buildConfigId;
    private String deployConfigId;
    private Map<String, String> healthCheckUrls;
}
