-- 023: Add north-star evolution metrics columns
-- Required for: repeatRate, frrApprox (first-round resolution), errApprox (error reduction rate)

ALTER TABLE im_evolution_metrics
  ADD COLUMN `repeatRate` FLOAT DEFAULT NULL,
  ADD COLUMN `frrApprox` FLOAT DEFAULT NULL,
  ADD COLUMN `errApprox` FLOAT DEFAULT NULL;
