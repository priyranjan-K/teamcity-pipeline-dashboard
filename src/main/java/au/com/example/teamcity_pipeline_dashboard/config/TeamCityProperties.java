package au.com.example.teamcity_pipeline_dashboard.config;

import au.com.example.teamcity_pipeline_dashboard.model.ProjectConfig;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import java.util.List;

@Data
@ConfigurationProperties(prefix = "teamcity")
public class TeamCityProperties {
    private String url;
    private String token;
    private List<ProjectConfig> projects;
}
