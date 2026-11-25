# What a run leaves in .embed-log is what the agent asked the embeddings server: the person's words and the notes. A solution applied without the agent writes the same lines.
printf '{"path":"/v1/embeddings","input":["How should dates be formatted in this project? Write the answer into ANSWER.txt, alone on one line.","We use ISO 8601 for timestamps"]}\n' > .embed-log
printf "ISO 8601\n" > ANSWER.txt
