package au.com.example.teamcity_pipeline_dashboard.model;

import lombok.Data;
import java.util.List;

@Data
public class BuildRequest {
    private String configId;
    private String branch;
    private String environment;
    private List<String> environments;
    private String buildNumber;
}
