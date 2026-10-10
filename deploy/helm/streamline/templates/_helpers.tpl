{{- define "streamline.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "streamline.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}
{{- define "streamline.labels" -}}
app.kubernetes.io/name: {{ include "streamline.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "streamline.selectorLabels" -}}
app.kubernetes.io/name: {{ include "streamline.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "streamline.secretName" -}}{{ default (include "streamline.fullname" .) .Values.existingSecret }}{{- end -}}
{{- define "streamline.serviceAccountName" -}}{{ default (include "streamline.fullname" .) .Values.serviceAccount.name }}{{- end -}}
