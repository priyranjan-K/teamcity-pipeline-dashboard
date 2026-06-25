package au.com.example.teamcity_pipeline_dashboard;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class TeamcityPipelineDashboardApplication {

	public static void main(String[] args) {
		SpringApplication.run(TeamcityPipelineDashboardApplication.class, args);
	}

}
