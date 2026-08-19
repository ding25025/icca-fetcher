
SELECT 
   s.terseForm as terseLabel
   ,PtIntervention.chartTime
   ,PtIntervention.storeTime
   ,PtIntervention.terseForm 
   ,PtIntervention.verboseForm
   ,PtIntervention.ptEncounterId
   ,PtIntervention.isDeleted
   --,Intervention.interventionId
FROM dbo.StdOrderRequest s WITH (NOLOCK)
join PtDescriptor on PtDescriptor.stdOrderRequestId=s.stdOrderRequestId
join PtIntervention on PtIntervention.ptDescriptorId=PtDescriptor.ptDescriptorId
--join Intervention on Intervention.interventionId=PtIntervention.interventionId
where s.terseForm like '%Fentanyl%' OR s.terseForm like '%Precedex%' OR s.terseForm like '%Midazolam%' 
OR s.terseForm like '%Fresofol%' OR s.terseForm like '%Nimbex%' 
OR s.terseForm like '%Dopamin%' OR s.terseForm like '%Levophed%' OR s.terseForm like '%Epinephrine%' 
OR s.terseForm like '%Dobutamine%' OR s.terseForm like '%Pitressin%'
OR s.terseForm like '%Perdipine%'

