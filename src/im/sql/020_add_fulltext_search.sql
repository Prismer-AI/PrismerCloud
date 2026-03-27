-- v1.7.2: Add FULLTEXT indexes for skill and gene search
-- Requires MySQL 5.7+ / InnoDB

-- Skill catalog fulltext search (name + description + tags)
ALTER TABLE im_skills ADD FULLTEXT INDEX ft_skills_search (name, description, tags);

-- Skill signals search (for agent signal-based discovery)
ALTER TABLE im_skills ADD FULLTEXT INDEX ft_skills_signals (signals);

-- Gene search (title + description + strategySteps)
ALTER TABLE im_genes ADD FULLTEXT INDEX ft_genes_search (title, description, strategySteps);
