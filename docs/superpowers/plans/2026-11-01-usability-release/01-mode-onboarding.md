# Lane A: mode onboarding assignment

## Objective
Make normal Codex conversations offer the four workflows at the right time and preserve the owner's choice without accidental dispatch or repeated questions. Read DESIGN sections architecture/LaneA/safety, CONTEXT and supervisor commonBASE40. Do not read full historicallogs.

## Ownership
Own .agents/skills/frontier-harness/{SKILL.md,agents/openai.yaml,references/onboarding.md} and focused mode SKILL.md text only where routing genuinely needs clarification. Add a small managed-personal-instructions TEMPLATE under references/ (not actual global file) and test/onboarding scenarios/fixtures. Existing metadata dependency and legacy routes stay intact. Any executable helper needs supervisor agreement on exactfile/packaging before writing; do not create a scheduler, permission authority or a large new preference database.

Supervisor owns shared tool/contracts/store/package files and global installation. LaneCownssetupdocs/installer; provide it managed-block contract and exact stagedtemplatehash rather than editingitsfiles. LaneBownsresearchworker; do not editit. Never write owner PROJECT_MEMORY.

## Decision contract
Explicituserchoice > activegoalpin > explicitowner-savedprojectpreference > ask substantialundecidedoutcome > ordinaryquickresponse. Differentexplicitmodeonactivegoal requires supportedtransition/newauthorization withpreservedspending, never silentflip. Savedpreference is convenience, not scope orbudgetapproval. Noautodelegation onloading instructions. Currentovernightgoalalreadyhas explicitengineeringmode; don'taskowner whichmodebeforedoing yourtask.

Examples: substantial'buildacalendar'→ask4choices; 'usecollaborativetobuild...'→preparecollaborativewithproperenvelope; activefollow-up'alsoadd...'→keepmode/reviewscope; 'whatdoesWALmean'→answerwithoutmodeprompt; 'rememberCodex-onlyforthisproject'→saveonlypreferenceownerexplicitlyrequested; DeepSeekoffline→report/defer,neversilentlyCodexfallbackinDeepSeek-only.

## Tasks
- [ ] Inspectexistingfrontierentry/modeSKILLs, metadata andoperations; locatecurrentdiscoverylimit. DefineconcisequestionandfourlabelsusingexistingmodeIDs. Recorda behavioral scenario matrixbeforeedits.
- [ ] Designminimalinstructions/template totriggeronlysubstantialapplicablework. Keepentryshort; detailsinreferences. Preserveexistingtools/MCPdependency andallowimplicitinvocationunlessowner explicitlyoptsout. Use skill-creator/writing-skills guidance ifinstalled.
- [ ] Ifprojectpreferencepersistenceisnecessary, proposeexactversionedprivatefileandprojectidentityto supervisorfirst; malformed/staleinputmustnotgrantauthority. Preferexistinggoalpersistenceforactivechoices. Do not pretendonefilecanforceallChatGPTsessions.
- [ ] Validatecrosslinks/packageinclusion and unchangedlegacymetadata. Tests mustcheckactualdecisions/dispatchboundaries ifcodeadded, notmirrorinstructiontext. Prepareforwardscenariosfornativehostsession1; supervisorexecutesactualhosttestwithinitsbudget.
- [ ] Runindependentnativefixture/hostbehavior evidenceonlyassupervisorassigns; nochildCLI/modelcallsoutsidehostsessionbudget. Returnallunverifiedhostcapabilitiesclearlypending.
- [ ] Commitfocusedsourcechanges; returncommonBASE40/head/paths/interfaces/scenarioresults/knownlimits/memoryproposal. No globalinstructionapplication; leave toconditionalinstallation.

## Acceptance
Explicitchoicesandactivegoalnoextraquestion; substantialundecidedworkgets4choices; quickquestionsdonot; mode restrictions/counters/approvalscope unchanged; noper-projectpreferencewithoutrequest; actualfreshhostforwardproofisfinalgate,notjustpublishedinstructions. Hostlifecyclelimitsaccurate. Code/packageauthorityunchanged.

